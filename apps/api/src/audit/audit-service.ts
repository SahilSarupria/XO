import { randomUUID } from 'node:crypto';
import { AuditError, ErrorCode, XoError } from '@xo/errors';
import {
  actorFromPrincipal,
  isDurableReceipt,
  type AuditEventDraft,
  type AuditSink,
  type AuditTargetKind,
  type DurableReceipt,
} from '@xo/audit';
import type { ApiRequest } from '../http/types.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { requireOwnedWorkspace, requirePrincipal } from '../workspace/workspace-context.js';

/**
 * Outcome of recording the COMPLETION of an operation that already happened. `failed` means the real operation outcome
 * stands (it was NOT undone and must not be retried) but its completion evidence is missing: an operator must reconcile
 * using the correlation/execution ids. See docs/audit-operations.md.
 */
export interface AuditFinalization {
  readonly status: 'recorded' | 'failed';
  readonly correlationId: string;
  readonly executionId?: string;
}

export interface AuditFailureInfo {
  readonly phase: 'precondition' | 'denial' | 'completion';
  readonly code: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** A client-supplied path parameter is only ever used as an audit target id if it is already well-formed. */
export function safeId(raw: string | undefined): string | undefined {
  return raw !== undefined && ID_RE.test(raw) ? raw : undefined;
}

export function newCorrelationId(): string {
  return `req-${randomUUID()}`;
}

/**
 * The API's single door to the audit port. It owns the three failure semantics the milestone requires:
 *  - {@link requireDurable}: a PRECONDITION. If durable evidence cannot be confirmed, throws `AUDIT_UNAVAILABLE`;
 *    the caller has not yet done anything and MUST NOT proceed (fail closed).
 *  - {@link tryRecord}: denials. Never throws; a denial is enforced regardless of whether the record could be written.
 *  - {@link finalize}: completion after a side effect. Never throws and never retries the side effect.
 * Audit-storage failures are reported through `onFailure` (a logger hook that does NOT write to the audit path), and
 * carry only the phase and a stable code — never event content.
 */
export class AuditService {
  private failures = 0;
  constructor(
    private readonly sink: AuditSink,
    private readonly onFailure: (info: AuditFailureInfo) => void = () => undefined,
  ) {}

  get mode(): 'durable' | 'non-production' {
    return this.sink.mode;
  }
  /** Count of audit-write failures since startup (operational signal; also logged via `onFailure`). */
  get failureCount(): number {
    return this.failures;
  }

  private async write(draft: AuditEventDraft, phase: AuditFailureInfo['phase']): Promise<DurableReceipt | undefined> {
    let receipt: DurableReceipt | undefined;
    let code: string = ErrorCode.AUDIT_UNAVAILABLE;
    try {
      const result = await this.sink.append(draft);
      if (result.ok) {
        const volatileOk = this.sink.mode === 'non-production' && result.receipt.guarantee === 'volatile-memory';
        if (isDurableReceipt(result.receipt) && (result.receipt.guarantee === 'fsync-file' || volatileOk)) receipt = result.receipt;
      } else code = result.error.code;
    } catch {
      /* a sink that throws is a failed write */
    }
    if (receipt === undefined) {
      this.failures++;
      try {
        this.onFailure({ phase, code });
      } catch {
        /* the failure hook must never break the request */
      }
    }
    return receipt;
  }

  async requireDurable(draft: AuditEventDraft): Promise<DurableReceipt> {
    const receipt = await this.write(draft, 'precondition');
    if (receipt === undefined) {
      throw new AuditError(
        ErrorCode.AUDIT_UNAVAILABLE,
        'required audit evidence could not be durably recorded; the operation was NOT performed',
      );
    }
    return receipt;
  }

  async tryRecord(draft: AuditEventDraft): Promise<boolean> {
    return (await this.write(draft, 'denial')) !== undefined;
  }

  async finalize(
    draft: AuditEventDraft,
    ids: { readonly correlationId: string; readonly executionId?: string },
  ): Promise<AuditFinalization> {
    const receipt = await this.write(draft, 'completion');
    return {
      status: receipt === undefined ? 'failed' : 'recorded',
      correlationId: ids.correlationId,
      ...(ids.executionId !== undefined ? { executionId: ids.executionId } : {}),
    };
  }
}

/** The shape of the sanitized notice added to a response when completion evidence could not be recorded. */
export function finalizationNotice(f: AuditFinalization): { readonly auditFinalization: AuditFinalization } | Record<string, never> {
  return f.status === 'failed' ? { auditFinalization: f } : {};
}

export interface RequestAuditContext {
  readonly audit: AuditService;
  readonly workspaceStore: WorkspaceStore;
}

/**
 * Resolves the owned workspace like every route does, but records a denial first when ownership fails (best-effort:
 * the 404 is returned either way). The denial target is only the well-formed workspace id parameter.
 */
export async function auditedOwnedWorkspace(
  req: ApiRequest,
  ctx: RequestAuditContext,
  spec: { readonly action: string; readonly correlationId: string },
): Promise<WorkspaceRecord> {
  try {
    return await requireOwnedWorkspace(req, ctx.workspaceStore);
  } catch (cause) {
    const workspaceId = safeId(req.params['workspaceId']);
    try {
      await ctx.audit.tryRecord({
        type: 'access.denied',
        action: spec.action,
        outcome: 'denied',
        actor: actorFromPrincipal(requirePrincipal(req)),
        ...(workspaceId !== undefined ? { target: { kind: 'workspace' as const, id: workspaceId } } : {}),
        correlationId: spec.correlationId,
        reasonCode: cause instanceof XoError ? cause.code : ErrorCode.UNKNOWN,
      });
    } catch {
      /* never let denial bookkeeping change the response */
    }
    throw cause;
  }
}

/**
 * PROTECTED READ. Order is fixed and is the milestone's core read guarantee:
 *   1. resolve the verified actor and authoritative workspace ownership (denial => recorded, nothing read);
 *   2. durably record `access.attempted` — it says an access was ATTEMPTED, never that it completed;
 *   3. only after a confirmed receipt, run `read`. If step 2 fails, `read` is never invoked and no data is disclosed.
 */
export async function auditedRead<T>(
  req: ApiRequest,
  ctx: RequestAuditContext,
  spec: { readonly action: string; readonly kind: AuditTargetKind; readonly idParam?: string },
  read: (workspace: WorkspaceRecord) => Promise<T>,
): Promise<T> {
  const correlationId = newCorrelationId();
  const workspace = await auditedOwnedWorkspace(req, ctx, { action: spec.action, correlationId });
  const principal = requirePrincipal(req);
  const rawId = spec.idParam === undefined ? undefined : req.params[spec.idParam];
  const id = safeId(rawId);
  await ctx.audit.requireDurable({
    type: 'access.attempted',
    action: spec.action,
    outcome: 'attempted',
    actor: actorFromPrincipal(principal),
    target:
      id !== undefined ? { kind: spec.kind, id, workspaceId: workspace.workspaceId } : { kind: 'workspace', id: workspace.workspaceId },
    correlationId,
    ...(spec.idParam !== undefined && id === undefined ? { metadata: { requestedIdWellFormed: false } } : {}),
  });
  return read(workspace);
}

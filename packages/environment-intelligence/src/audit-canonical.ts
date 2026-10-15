import {
  ChainedAuditStore,
  NonProductionAuditSink,
  actorFromPrincipal,
  isDurableReceipt,
  type AppendResult,
  type AuditEventDraft,
  type AuditExtensionSchema,
  type AuditSink,
  type ChainedAuditStoreOptions,
} from '@xo/audit';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, type AuditError as PlatformAuditError } from '@xo/errors';
import { isAuthenticatedPrincipal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  auditError,
  isReceiptFor,
  normalizeAuditRecordRequest,
  type AuditError,
  type AuditReceipt,
  type AuditRecorder,
  type AuditRecordRequest,
  type AuditTrust,
} from './audit.js';

/**
 * C0.3 — the Environment Intelligence side of the CANONICAL audit path.
 *
 *   EI operation ──► CanonicalAuditRecorder (this file) ──► @xo/audit AuditSink (ChainedAuditStore in production)
 *
 * There is exactly ONE authoritative, writable history: the `@xo/audit` store. This file owns only what is genuinely
 * EI-specific: (1) the closed EI request schema (`normalizeAuditRecordRequest`, run FIRST), (2) the mapping of an EI
 * request onto a canonical draft + the closed `x-ei-audit` extension, (3) principal trust binding, and (4) translation of
 * results back into EI's receipt/error vocabulary. It holds no log, no hash chain and no lifecycle state of its own.
 */

export const EI_AUDIT_NAMESPACE = 'x-ei-audit';

/** The closed, bounded shape of everything EI records that does not fit a canonical field. Every leaf is typed. */
export const EI_AUDIT_EXTENSION_SCHEMA: AuditExtensionSchema = {
  namespace: EI_AUDIT_NAMESPACE,
  fields: {
    // The caller's clock reading: persisted, but NOT part of event identity, so a retry rebuilt after a restart is a duplicate.
    occurredAt: { kind: 'isoTime', volatile: true },
    connectorId: { kind: 'id' },
    connectorVersion: { kind: 'version', optional: true },
    sourceId: { kind: 'id', optional: true },
    permission: { kind: 'id', maxLength: 80 },
    requestedScope: {
      kind: 'object',
      optional: true,
      fields: { kind: { kind: 'enum', values: ['path', 'resource'] }, ref: { kind: 'id' } },
    },
    grantedScope: { kind: 'object', optional: true, fields: { kind: { kind: 'enum', values: ['path', 'resource'] }, ref: { kind: 'id' } } },
    decision: {
      kind: 'object',
      optional: true,
      fields: {
        effect: { kind: 'enum', values: ['allow', 'deny', 'prompt'] },
        authority: { kind: 'enum', values: ['platform', 'development_unverified', 'none'] },
        policyId: { kind: 'id', optional: true },
        lifetime: { kind: 'enum', values: ['once', 'session', 'persistent'], optional: true },
        reasonCode: { kind: 'id', maxLength: 70, optional: true },
      },
    },
    counts: {
      kind: 'object',
      optional: true,
      fields: {
        evidence: { kind: 'count', optional: true },
        skipped: { kind: 'count', optional: true },
        errors: { kind: 'count', optional: true },
        requestedKeys: { kind: 'count', optional: true },
      },
    },
    partial: { kind: 'bool', optional: true },
    evidenceIds: { kind: 'list', max: 10_000, of: { kind: 'id' }, optional: true },
    keysDigest: { kind: 'opaque', pattern: /^sha256:[0-9a-f]{64}$/, maxLength: 71, optional: true },
  },
};

const CODE_MAP: Readonly<Record<string, AuditErrorCode>> = {
  [ErrorCode.AUDIT_UNAVAILABLE]: AuditErrorCode.UNAVAILABLE,
  [ErrorCode.AUDIT_EVENT_INVALID]: AuditErrorCode.INVALID_EVENT,
  [ErrorCode.AUDIT_CONFLICT]: AuditErrorCode.CONFLICT,
  [ErrorCode.AUDIT_ORDER_VIOLATION]: AuditErrorCode.ORDER_VIOLATION,
  [ErrorCode.AUDIT_CORRUPT]: AuditErrorCode.CORRUPT,
  [ErrorCode.AUDIT_LOCKED]: AuditErrorCode.LOCKED,
  [ErrorCode.AUDIT_CONFIG_INVALID]: AuditErrorCode.INVALID_CONFIG,
  // Anything else (including an access-denied from a misconfigured sink) is "not accepted" and fails closed.
};

/** Platform error -> EI error. The platform message is NOT forwarded: EI's messages are fixed and content-free. */
export function toEiAuditError(e: PlatformAuditError, indeterminate = false): AuditError {
  const code = CODE_MAP[e.code] ?? AuditErrorCode.UNAVAILABLE;
  return auditError(code, 'the audit backend did not accept the event', { platformCode: e.code, indeterminate });
}

const SAFE_ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function bindPrincipal(request: AuditRecordRequest, trust: AuditTrust): Result<ReturnType<typeof actorFromPrincipal>, AuditError> {
  const trusted = trust?.principal;
  if (!isAuthenticatedPrincipal(trusted)) {
    return err(auditError(AuditErrorCode.INVALID_EVENT, 'the audit event has no trusted authenticated principal', { field: 'trust' }));
  }
  // The snapshot in the request is ATTRIBUTION, never proof. It must equal the principal the authentication boundary
  // established; a mismatch means the request was built for someone else, so nothing is recorded.
  const p = request.principal;
  if (p.kind !== trusted.kind || p.id !== trusted.id || (p.orgId ?? null) !== (trusted.orgId ?? null)) {
    return err(
      auditError(AuditErrorCode.INVALID_EVENT, 'the audit event principal does not match the authenticated principal', {
        field: 'principal',
      }),
    );
  }
  if (!SAFE_ACTOR_ID.test(trusted.id) || (trusted.orgId !== undefined && !SAFE_ACTOR_ID.test(trusted.orgId))) {
    return err(
      auditError(AuditErrorCode.INVALID_EVENT, 'the authenticated principal id is not representable in the audit log', {
        field: 'principal',
      }),
    );
  }
  try {
    return ok(actorFromPrincipal(trusted));
  } catch {
    return err(auditError(AuditErrorCode.INVALID_EVENT, 'the audit event principal could not be attributed', { field: 'principal' }));
  }
}

/** Pure mapping of a NORMALIZED EI request onto a canonical draft. Nothing outside the closed schema can be carried. */
export function toCanonicalDraft(request: AuditRecordRequest, actor: AuditEventDraft['actor']): AuditEventDraft {
  const ext: Record<string, unknown> = {
    occurredAt: request.occurredAt,
    connectorId: request.connectorId,
    permission: request.permission,
    ...(request.connectorVersion !== undefined ? { connectorVersion: request.connectorVersion } : {}),
    ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
    ...(request.requestedScope !== undefined ? { requestedScope: { ...request.requestedScope } } : {}),
    ...(request.grantedScope !== undefined ? { grantedScope: { ...request.grantedScope } } : {}),
    ...(request.decision !== undefined ? { decision: { ...request.decision } } : {}),
    ...(request.counts !== undefined ? { counts: { ...request.counts } } : {}),
    ...(request.partial !== undefined ? { partial: request.partial } : {}),
    ...(request.evidenceIds !== undefined ? { evidenceIds: [...request.evidenceIds] } : {}),
    ...(request.keysDigest !== undefined ? { keysDigest: request.keysDigest } : {}),
  };
  return {
    type: `environment.${request.outcome}`,
    action: `ei.${request.operation}`.replace(/_/g, '-'),
    outcome: request.outcome,
    actor,
    correlationId: request.operationId,
    ...(request.errorCode !== undefined ? { reasonCode: request.errorCode } : {}),
    idempotencyKey: request.idempotencyKey,
    lifecycle: { operationId: request.operationId, phase: request.phase },
    extensions: { [EI_AUDIT_NAMESPACE]: ext },
  };
}

export interface CanonicalAuditRecorderOptions {
  /** Accept a `volatile-memory` receipt. ONLY for the non-production sink used in tests; production sinks never need it. */
  readonly allowVolatileReceipt?: boolean;
}

/** The EI `AuditRecorder` backed by a canonical `@xo/audit` sink. */
export class CanonicalAuditRecorder implements AuditRecorder {
  constructor(
    private readonly sink: AuditSink,
    private readonly options: CanonicalAuditRecorderOptions = {},
  ) {}

  async record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    const normalized = normalizeAuditRecordRequest(event);
    if (!normalized.ok) return normalized;
    const actor = bindPrincipal(normalized.value, trust);
    if (!actor.ok) return actor;
    const draft = toCanonicalDraft(normalized.value, actor.value);

    let result: AppendResult;
    try {
      result = await this.sink.append(draft);
    } catch {
      // `AuditSink.append` is contractually non-throwing; a throw is an unconfirmed write.
      return err(auditError(AuditErrorCode.UNAVAILABLE, 'the audit backend did not accept the event', { indeterminate: true }));
    }
    if (!result.ok) return err(toEiAuditError(result.error, result.indeterminate));

    // "Accepted" requires a platform-minted receipt with the guarantee the contract needs.
    const volatileOk = this.options.allowVolatileReceipt === true && result.receipt.guarantee === 'volatile-memory';
    if (!isDurableReceipt(result.receipt) || (result.receipt.guarantee !== 'fsync-file' && !volatileOk)) {
      return err(
        auditError(AuditErrorCode.UNAVAILABLE, 'the audit backend returned a receipt without the required durability', {
          indeterminate: true,
        }),
      );
    }
    const receipt: AuditReceipt = {
      eventId: result.event.eventId,
      sequence: result.event.seq,
      recordedAt: result.event.recordedAt,
      idempotencyKey: normalized.value.idempotencyKey,
      outcome: normalized.value.outcome,
      duplicate: result.duplicate,
    };
    if (!isReceiptFor(receipt, normalized.value) || result.event.idempotencyKey !== normalized.value.idempotencyKey) {
      return err(
        auditError(AuditErrorCode.UNAVAILABLE, 'the audit backend returned a receipt for a different event', { indeterminate: true }),
      );
    }
    return ok(receipt);
  }
}

/** The pre-C0.3 EI log. It is never migrated and never coexists with the canonical history. */
export const LEGACY_EI_LOG_FILE = 'audit.log';

/**
 * Opens the canonical chained store with the EI extension registered. This is the ONE writable history for EI audit
 * events. A directory still holding a pre-C0.3 `audit.log` is refused here (not only in the deprecated `FileAuditLog`
 * shim), so no entry point can create a second history next to it.
 */
export async function openEiAuditStore(
  options: Omit<ChainedAuditStoreOptions, 'extensionSchemas'>,
): Promise<Result<ChainedAuditStore, AuditError>> {
  const legacy = await stat(join(options.dir, LEGACY_EI_LOG_FILE)).then(
    () => true,
    () => false,
  );
  if (legacy) {
    return err(
      auditError(
        AuditErrorCode.INVALID_CONFIG,
        'a pre-C0.3 audit.log exists in this directory; it is not migrated and would create a second history',
      ),
    );
  }
  const r = await ChainedAuditStore.open({ ...options, extensionSchemas: { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA } });
  return r.ok ? ok(r.value) : err(toEiAuditError(r.error));
}

/**
 * Non-durable recorder for tests and local demos: the canonical semantics (idempotency, conflict, lifecycle, closed schema)
 * over `NonProductionAuditSink`. Receipts are `volatile-memory` and this class says so; it can never satisfy a production
 * durability requirement.
 */
export class InMemoryAuditRecorder implements AuditRecorder {
  private readonly sink: NonProductionAuditSink;
  private readonly inner: CanonicalAuditRecorder;
  private readonly accepted: AuditRecordRequest[] = [];
  private readonly receiptList: AuditReceipt[] = [];

  constructor(now: () => Date = () => new Date()) {
    this.sink = new NonProductionAuditSink(now, { extensionSchemas: { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA } });
    this.inner = new CanonicalAuditRecorder(this.sink, { allowVolatileReceipt: true });
  }

  async record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    const r = await this.inner.record(event, trust);
    if (r.ok && !r.value.duplicate) {
      const normalized = normalizeAuditRecordRequest(event);
      if (normalized.ok) {
        this.accepted.push(normalized.value);
        this.receiptList.push(r.value);
      }
    }
    return r;
  }

  events(): readonly AuditRecordRequest[] {
    return [...this.accepted];
  }

  receipts(): readonly AuditReceipt[] {
    return [...this.receiptList];
  }

  openAttempts(): readonly string[] {
    return this.sink.openAttempts();
  }
}

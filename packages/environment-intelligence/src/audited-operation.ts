import { randomUUID } from 'node:crypto';
import type { PermissionScope } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  auditError,
  digestKeys,
  isReceiptFor,
  normalizeAuditRecordRequest,
  safeIdentifier,
  scopeRef,
  type AuditCounts,
  type AuditError,
  type AuditOperation,
  type AuditOutcome,
  type AuditReceipt,
  type AuditRecordRequest,
  type AuditRecorder,
} from './audit.js';
import { requireAuthenticatedPrincipal, type TrustedAllow } from './authorization-gate.js';
import type { ConnectorContext } from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import type { Evidence } from './evidence.js';
import type { SkippedSummary } from './connector.js';

/**
 * The M2.2 evidence lifecycle for ONE protected operation (discover or acquire_content):
 *
 *   authorize -> ATTEMPT audit accepted -> read -> COMPLETION audit accepted -> release
 *
 *  - Write-ahead: `beginAudit` resolves only after the attempt record was ACCEPTED (awaited, validated receipt). If it
 *    was not, the operation returns `EI_AUDIT_UNAVAILABLE` and the caller never reads anything.
 *  - Completion: `finish` records the outcome (completed / failed / cancelled) AFTER the work, with the same
 *    idempotency key on every retry, and the completion write is NOT tied to the caller's abort signal, so a
 *    cancellation can still be recorded.
 *  - Quarantine: if evidence was acquired but the completion record is not accepted, the evidence is withheld
 *    (ledger state `quarantined`) and the caller gets `EI_EVIDENCE_QUARANTINED`, never the evidence.
 *  - No false success: a successful result is returned only when its completion record was accepted.
 *  - No detached writes: every audit write is awaited in sequence before the next step; nothing is fire-and-forget,
 *    so a pending write can never satisfy (or race past) a required acceptance.
 */

export const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000;
export const DEFAULT_AUDIT_ATTEMPTS = 2;

export interface AuditOptions {
  /** How long to wait for ONE `record()` call before treating it as unconfirmed (and therefore not accepted). */
  readonly acceptTimeoutMs?: number;
  /** Tries per event (same idempotency key each time). At least 1. */
  readonly attempts?: number;
  /** Operation id source (injected for deterministic tests). Must yield a log-safe id. */
  readonly newOperationId?: () => string;
}

const TIMED_OUT = Symbol('timed-out');

/** One awaited, validated, bounded acceptance of an event. Never throws; `true` only for a receipt that names this event. */
export async function acceptAuditEvent(
  recorder: AuditRecorder,
  event: AuditRecordRequest,
  options: AuditOptions = {},
): Promise<Result<AuditReceipt, AuditError>> {
  const normalized = normalizeAuditRecordRequest(event);
  if (!normalized.ok) return normalized;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_AUDIT_ATTEMPTS);
  const timeoutMs = options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS;
  let last = auditError(AuditErrorCode.UNAVAILABLE, 'the audit recorder did not accept the event');
  for (let i = 0; i < attempts; i += 1) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      const outcome = await Promise.race([recorder.record(normalized.value), timeout]);
      if (outcome === TIMED_OUT) {
        last = auditError(AuditErrorCode.UNAVAILABLE, 'the audit recorder did not confirm the event in time');
        continue;
      }
      if (outcome === null || typeof outcome !== 'object' || typeof (outcome as { ok?: unknown }).ok !== 'boolean') {
        last = auditError(AuditErrorCode.UNAVAILABLE, 'the audit recorder returned a malformed answer');
        continue;
      }
      if (!outcome.ok) {
        last = outcome.error;
        // Contradictions and invalid events are not transient: retrying cannot help and must not be attempted again.
        if (!last.retryable) return err(last);
        continue;
      }
      if (!isReceiptFor(outcome.value, normalized.value)) {
        last = auditError(AuditErrorCode.UNAVAILABLE, 'the audit recorder returned a receipt that does not match the event');
        continue;
      }
      return ok(outcome.value);
    } catch {
      last = auditError(AuditErrorCode.UNAVAILABLE, 'the audit recorder failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return err(last);
}

const now = (ctx: ConnectorContext): string => ctx.clock.now().toISOString();

export interface AuditedOperationInfo {
  readonly operation: Extract<AuditOperation, 'discover' | 'acquire_content' | 'revoke_evidence' | 'purge_evidence'>;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly permission: string;
  /** The authorized scope. Hashed into an opaque scope reference; never recorded. */
  readonly scope: PermissionScope;
  readonly allow: TrustedAllow;
  readonly sourceId: string;
  readonly requestedKeys?: readonly string[];
}

interface Completable {
  readonly status: 'complete' | 'partial';
  readonly evidence: readonly Evidence[];
  readonly skipped: SkippedSummary;
  readonly errors: readonly DiscoveryError[];
  readonly limits: { readonly hit: readonly string[] };
}

const unavailable = (
  phase: 'attempt' | 'completion',
  operationId: string,
  extra: Record<string, string | number | boolean> = {},
): DiscoveryError =>
  discoveryError(
    DiscoveryErrorCode.AUDIT_UNAVAILABLE,
    phase === 'attempt'
      ? 'the audit attempt was not accepted; protected evidence was not read'
      : 'the completion audit was not accepted; the operation is not reported as completed',
    { phase, operationId, ...extra },
  );

export class AuditSession {
  constructor(
    private readonly recorder: AuditRecorder,
    private readonly ctx: ConnectorContext,
    private readonly info: AuditedOperationInfo,
    readonly operationId: string,
    private readonly options: AuditOptions,
  ) {}

  private base(outcome: AuditOutcome): AuditRecordRequest {
    return baseFields(this.ctx, this.info, this.operationId, 'terminal', outcome);
  }

  /**
   * Closing event for operations that have no evidence payload to release (revoke / purge). Returns the receipt
   * only when the record was ACCEPTED; the caller must not report the operation as audited otherwise.
   */
  async complete(
    outcome: Extract<AuditOutcome, 'failed' | 'revoked' | 'purged'>,
    detail: { readonly evidenceIds?: readonly string[]; readonly errorCode?: string },
  ): Promise<AuditReceipt | undefined> {
    const ids = detail.evidenceIds ?? [];
    const event: AuditRecordRequest = {
      ...this.base(outcome),
      ...(detail.errorCode !== undefined ? { errorCode: detail.errorCode } : {}),
      counts: { evidence: ids.length },
      ...(ids.length > 0 && ids.length <= 10_000 ? { evidenceIds: ids } : {}),
    };
    const accepted = await acceptAuditEvent(this.recorder, event, this.options);
    return accepted.ok ? accepted.value : undefined;
  }

  /**
   * Records the closing event and decides whether the result may be released.
   * Returns the result untouched ONLY when its completion record was accepted.
   */
  async finish<T extends Completable>(result: Result<T, DiscoveryError>): Promise<Result<T, DiscoveryError>> {
    const aborted = this.ctx.signal?.aborted === true;
    let outcome: AuditOutcome;
    let errorCode: string | undefined;
    let counts: AuditCounts = {};
    let evidence: readonly Evidence[] = [];
    let partial: boolean | undefined;
    if (!result.ok) {
      outcome = result.error.code === DiscoveryErrorCode.CANCELLED ? 'cancelled' : 'failed';
      errorCode = result.error.code;
    } else {
      evidence = result.value.evidence;
      const skipped = Object.values(result.value.skipped.byReason).reduce((a, b) => a + b, 0);
      counts = { evidence: evidence.length, skipped, errors: result.value.errors.length };
      partial = result.value.status === 'partial';
      const cancelled =
        aborted ||
        result.value.limits.hit.includes('cancelled') ||
        result.value.errors.some((e) => e.code === DiscoveryErrorCode.CANCELLED);
      outcome = cancelled ? 'cancelled' : 'completed';
      if (cancelled) errorCode = DiscoveryErrorCode.CANCELLED;
    }
    const ids = [...new Set(evidence.map((e) => e.id as string))].sort();
    const event: AuditRecordRequest = {
      ...this.base(outcome),
      ...(errorCode !== undefined ? { errorCode } : {}),
      counts: { ...counts, ...(this.info.requestedKeys !== undefined ? { requestedKeys: this.info.requestedKeys.length } : {}) },
      ...(partial !== undefined ? { partial } : {}),
      ...(ids.length > 0 && ids.length <= 10_000 ? { evidenceIds: ids } : {}),
    };
    // Deliberately NOT tied to the caller's abort signal: a cancelled operation must still be recorded.
    const accepted = await acceptAuditEvent(this.recorder, event, this.options);
    if (accepted.ok) {
      if (result.ok) this.ctx.ledger?.release(this.operationId, evidence);
      return result;
    }
    if (!result.ok) return result; // The operation already failed; its (unrecorded) failure is the answer, not an audit error.
    if (evidence.length === 0) return err(unavailable('completion', this.operationId));
    // Evidence in hand, completion not accepted: quarantine. The result is dropped; only opaque ids are kept.
    this.ctx.ledger?.quarantine(this.operationId, evidence);
    const quarantineEvent: AuditRecordRequest = {
      ...this.base('quarantined'),
      errorCode: DiscoveryErrorCode.AUDIT_UNAVAILABLE,
      counts: { evidence: evidence.length },
      ...(ids.length <= 10_000 ? { evidenceIds: ids } : {}),
    };
    const recorded = await acceptAuditEvent(this.recorder, quarantineEvent, { ...this.options, attempts: 1 });
    return err(
      discoveryError(
        DiscoveryErrorCode.EVIDENCE_QUARANTINED,
        'the completion audit was not accepted; the acquired evidence was quarantined and not released',
        {
          operationId: this.operationId,
          evidenceCount: evidence.length,
          quarantineAudited: recorded.ok,
        },
      ),
    );
  }
}

function baseFields(
  ctx: ConnectorContext,
  info: AuditedOperationInfo,
  operationId: string,
  phase: 'attempt' | 'terminal',
  outcome: AuditOutcome,
): AuditRecordRequest {
  const requested = scopeRef(info.scope);
  const granted = info.allow.grant.grantedScope === undefined ? undefined : scopeRef(info.allow.grant.grantedScope);
  return {
    idempotencyKey: `${operationId}:${phase}`,
    operationId,
    phase,
    outcome,
    operation: info.operation,
    occurredAt: now(ctx),
    principal: info.allow.principal,
    connectorId: info.connectorId,
    connectorVersion: info.connectorVersion,
    sourceId: info.sourceId,
    permission: info.permission,
    ...(requested !== undefined ? { requestedScope: requested } : {}),
    ...(granted !== undefined ? { grantedScope: granted } : {}),
    decision: {
      effect: 'allow' as const,
      authority: info.allow.authority,
      ...(info.allow.grant.policyId !== undefined ? { policyId: safeIdentifier(info.allow.grant.policyId) } : {}),
      ...(info.allow.grant.lifetime !== undefined ? { lifetime: info.allow.grant.lifetime } : {}),
    },
    ...(info.requestedKeys !== undefined ? { keysDigest: digestKeys(info.requestedKeys) } : {}),
  };
}

/** Runs the protected work and routes its result (or an unexpected throw) through the completion audit. */
export async function runAudited<T extends Completable>(
  session: AuditSession,
  run: () => Promise<Result<T, DiscoveryError>>,
): Promise<Result<T, DiscoveryError>> {
  let result: Result<T, DiscoveryError>;
  try {
    result = await run();
  } catch (e) {
    result = err(internalError(e, 'audited operation'));
  }
  return session.finish(result);
}

/**
 * Write-ahead step. Call AFTER authorization succeeded and BEFORE any protected read. Fails closed: no recorder
 * configured, an invalid event, a rejection, a throw, a timeout or a mismatched receipt all return
 * `EI_AUDIT_UNAVAILABLE`, and the caller must stop without reading.
 */
export async function beginAudit(
  ctx: ConnectorContext,
  info: AuditedOperationInfo,
  operationIdOverride?: string,
): Promise<Result<AuditSession, DiscoveryError>> {
  const options = ctx.auditOptions ?? {};
  const operationId = operationIdOverride ?? (options.newOperationId ?? (() => `op_${randomUUID()}`))();
  const recorder = ctx.audit;
  if (recorder === undefined) {
    return err(
      discoveryError(DiscoveryErrorCode.AUDIT_UNAVAILABLE, 'no audit recorder is configured; protected evidence access is refused', {
        phase: 'attempt',
        operationId,
      }),
    );
  }
  const event = baseFields(ctx, info, operationId, 'attempt', 'attempted');
  const accepted = await acceptAuditEvent(recorder, event, options);
  if (!accepted.ok) return err(unavailable('attempt', operationId, { auditCode: accepted.error.code }));
  return ok(new AuditSession(recorder, ctx, info, operationId, options));
}

/**
 * Records an authorization denial as a standalone `denied` event. Best-effort by design: a denial already blocks
 * the operation, so a failed write cannot let anything through; it returns whether the event was accepted.
 * Unauthenticated callers are not audited (there is no verified identity to attribute, and the request is rejected
 * before any decision exists).
 */
export async function auditDenial(
  ctx: ConnectorContext,
  info: {
    readonly operation: AuditOperation;
    readonly connectorId: string;
    readonly permission: string;
    readonly scope: PermissionScope;
    readonly error: DiscoveryError;
  },
): Promise<boolean> {
  const recorder = ctx.audit;
  if (recorder === undefined) return false;
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return false;
  const code = info.error.code;
  if (
    code !== DiscoveryErrorCode.AUTHORIZATION_DENIED &&
    code !== DiscoveryErrorCode.AUTHORIZATION_REQUIRED &&
    code !== DiscoveryErrorCode.SCOPE_VIOLATION
  )
    return false;
  const options = ctx.auditOptions ?? {};
  const operationId = (options.newOperationId ?? (() => `op_${randomUUID()}`))();
  const authority = info.error.context['authority'];
  const requested = scopeRef(info.scope);
  const event: AuditRecordRequest = {
    idempotencyKey: `${operationId}:standalone`,
    operationId,
    phase: 'standalone',
    outcome: 'denied',
    operation: info.operation,
    occurredAt: now(ctx),
    principal: who.value,
    connectorId: info.connectorId,
    permission: info.permission,
    ...(requested !== undefined ? { requestedScope: requested } : {}),
    decision: {
      effect: code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED ? 'prompt' : 'deny',
      authority: authority === 'platform' || authority === 'development_unverified' ? authority : 'none',
      reasonCode: code,
    },
    errorCode: code,
  };
  const accepted = await acceptAuditEvent(recorder, event, options);
  return accepted.ok;
}

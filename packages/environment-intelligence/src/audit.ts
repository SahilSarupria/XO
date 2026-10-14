import { createHash } from 'node:crypto';
import { scopeKey, type AuthenticatedPrincipal, type PermissionScope, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuthorityKind } from './authorization.js';
import { stableDigest } from './ids.js';

/**
 * M2.2 - the audit port between Environment Intelligence and ANY audit
 * implementation. Deliberately small and technology-neutral: EI submits one
 * `AuditRecordRequest` and gets back either a signed-off `AuditReceipt` or an
 * `AuditError`. Persistence (P1.0 M4) lives behind this interface and nothing in
 * EI depends on how it is stored.
 *
 * "Accepted" has exactly one meaning: `record()` RESOLVED with an `ok` receipt
 * that names the event that was submitted. A rejection, a throw, a timeout, a
 * malformed receipt or a receipt for a different event are all "not accepted".
 * A caller must never treat an unconfirmed write as accepted, and must never
 * satisfy a required write-ahead guarantee with a detached (un-awaited) write.
 */

/** Explicit, non-overlapping outcomes. There is no generic "success". */
export type AuditOutcome = 'attempted' | 'denied' | 'failed' | 'cancelled' | 'completed' | 'quarantined' | 'revoked' | 'purged';

/** Which protected operation an event describes. */
export type AuditOperation =
  'detect' | 'validate_connection' | 'discover' | 'acquire_content' | 'declare_sources' | 'revoke_evidence' | 'purge_evidence';

/**
 * - `attempt`:    write-ahead record, accepted BEFORE protected evidence is read.
 * - `terminal`:   the single closing record of an operation (completed / failed / cancelled / quarantined / revoked / purged).
 * - `standalone`: an event that has no attempt (an authorization denial: nothing was read).
 */
export type AuditPhase = 'attempt' | 'terminal' | 'standalone';

/** Opaque reference to a scope. The scope itself (which can be an absolute host path) is never recorded. */
export interface AuditScopeRef {
  readonly kind: 'path' | 'resource';
  readonly ref: string;
}

export interface AuditDecisionContext {
  readonly effect: 'allow' | 'deny' | 'prompt';
  readonly authority: Exclude<AuthorityKind, 'none'> | 'none';
  /** Platform policy id, when one was reported and is log-safe; otherwise a digest. */
  readonly policyId?: string;
  readonly lifetime?: 'once' | 'session' | 'persistent';
  /** Fixed reason CODE (e.g. `EI_AUTHORIZATION_DENIED`), never the decision's free-text reason. */
  readonly reasonCode?: string;
}

export interface AuditCounts {
  readonly evidence?: number;
  readonly skipped?: number;
  readonly errors?: number;
  readonly requestedKeys?: number;
}

/**
 * What EI submits. A CLOSED schema: only these fields exist, each value is
 * checked by `normalizeAuditRecordRequest`, and nothing here can carry raw
 * document content, secrets, tokens, credentials or a host path. Free text is
 * not representable; ids are restricted to a log-safe alphabet with no `/`.
 */
export interface AuditRecordRequest {
  /** `${operationId}:${phase}`. Identical requests with the same key are one event; a different request with the same key is a conflict. */
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly phase: AuditPhase;
  readonly outcome: AuditOutcome;
  readonly operation: AuditOperation;
  readonly occurredAt: string;
  /** Plain attribution snapshot of the AUTHENTICATED principal. */
  readonly principal: Principal;
  readonly connectorId: string;
  readonly connectorVersion?: string;
  readonly sourceId?: string;
  readonly permission: string;
  readonly requestedScope?: AuditScopeRef;
  readonly grantedScope?: AuditScopeRef;
  readonly decision?: AuditDecisionContext;
  /** `EI_*` error code for failed / denied / cancelled / quarantined outcomes. */
  readonly errorCode?: string;
  readonly counts?: AuditCounts;
  readonly partial?: boolean;
  /** Stable, content-derived evidence ids (opaque hashes), never evidence payloads. */
  readonly evidenceIds?: readonly string[];
  /** Digest of the requested resource keys; the keys themselves (source-relative paths) are not recorded. */
  readonly keysDigest?: string;
}

export interface AuditReceipt {
  readonly eventId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly outcome: AuditOutcome;
  /** True when the request was an exact retry of an already-accepted event (nothing new was written). */
  readonly duplicate: boolean;
}

/**
 * The REQUIRED trusted context of every audit write (C0.3). `principal` must be the AuthenticatedPrincipal established by
 * the authentication/authorization boundary (it carries the platform brand); the request's own `principal` is only an
 * attribution snapshot and is compared against it. A recorder MUST NOT derive the audit actor from the snapshot alone.
 */
export interface AuditTrust {
  readonly principal: AuthenticatedPrincipal;
}

export interface AuditRecorder {
  record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>>;
}

export const AuditErrorCode = {
  /** The backend could not accept the event now (I/O failure, closed, unconfirmed write, timeout). */
  UNAVAILABLE: 'AUDIT_UNAVAILABLE',
  /** The event does not satisfy the closed, content-free schema. Nothing was written. */
  INVALID_EVENT: 'AUDIT_INVALID_EVENT',
  /** Same idempotency key, different content (a contradictory outcome). Nothing was written. */
  CONFLICT: 'AUDIT_CONFLICT',
  /** A terminal event without a durable attempt, an attempt after a terminal, or a second terminal. Nothing was written. */
  ORDER_VIOLATION: 'AUDIT_ORDER_VIOLATION',
  /** The stored history failed verification; the backend refuses to append (fail closed). */
  CORRUPT: 'AUDIT_CORRUPT',
  /** Another writer holds the log. */
  LOCKED: 'AUDIT_LOCKED',
  /** The backend was configured inconsistently (e.g. integrity key vs. the log's recorded mode, retention shorter than evidence retention). */
  INVALID_CONFIG: 'AUDIT_INVALID_CONFIG',
} as const;
export type AuditErrorCode = (typeof AuditErrorCode)[keyof typeof AuditErrorCode];

/** Structured and safe to surface: fixed message, short sanitized context, never a payload, token or path. */
export interface AuditError {
  readonly code: AuditErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export function auditError(
  code: AuditErrorCode,
  message: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): AuditError {
  const retryable = code === AuditErrorCode.UNAVAILABLE || code === AuditErrorCode.LOCKED;
  return Object.freeze({ code, message, retryable, context: Object.freeze({ ...context }) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Closed-schema validation (data minimization)
// ---------------------------------------------------------------------------------------------------------------------

/** Log-safe identifier: alphanumeric start, then letters, digits and `._:@+-`. No `/`, no whitespace, so a path or free text cannot fit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const ERROR_CODE = /^(EI|AUDIT)_[A-Z_]{1,60}$/;
const PERMISSION = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const MAX_EVIDENCE_IDS = 10_000;

const PHASES: ReadonlySet<string> = new Set(['attempt', 'terminal', 'standalone']);
const OUTCOMES: ReadonlySet<string> = new Set([
  'attempted',
  'denied',
  'failed',
  'cancelled',
  'completed',
  'quarantined',
  'revoked',
  'purged',
]);
const OPERATIONS: ReadonlySet<string> = new Set([
  'detect',
  'validate_connection',
  'discover',
  'acquire_content',
  'declare_sources',
  'revoke_evidence',
  'purge_evidence',
]);
const TOP_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'operationId',
  'phase',
  'outcome',
  'operation',
  'occurredAt',
  'principal',
  'connectorId',
  'connectorVersion',
  'sourceId',
  'permission',
  'requestedScope',
  'grantedScope',
  'decision',
  'errorCode',
  'counts',
  'partial',
  'evidenceIds',
  'keysDigest',
]);

/** Which outcomes may appear in which phase. This is what keeps "attempted" and "completed" from being confused. */
const PHASE_OUTCOMES: Readonly<Record<AuditPhase, ReadonlySet<string>>> = {
  attempt: new Set(['attempted']),
  terminal: new Set(['failed', 'cancelled', 'completed', 'quarantined', 'revoked', 'purged']),
  standalone: new Set(['denied']),
};

const bad = (field: string): Result<never, AuditError> =>
  err(auditError(AuditErrorCode.INVALID_EVENT, 'the audit event does not satisfy the closed schema', { field }));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const safeId = (v: unknown): v is string => typeof v === 'string' && SAFE_ID.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

function normalizeScopeRef(v: unknown): AuditScopeRef | undefined {
  if (!isRecord(v) || !hasOnly(v, ['kind', 'ref'])) return undefined;
  if ((v['kind'] !== 'path' && v['kind'] !== 'resource') || !safeId(v['ref'])) return undefined;
  return { kind: v['kind'], ref: v['ref'] };
}

/**
 * Validates untrusted input into a fresh, frozen `AuditRecordRequest`, copying
 * ONLY known fields. Unknown fields are rejected (not ignored), so nothing else
 * can ride along. Every backend runs this, so the content-free guarantee does not
 * depend on the caller having been careful.
 */
export function normalizeAuditRecordRequest(input: unknown): Result<AuditRecordRequest, AuditError> {
  if (!isRecord(input)) return bad('event');
  for (const key of Object.keys(input)) if (!TOP_KEYS.has(key)) return bad(`unknown:${SAFE_ID.test(key) ? key : 'invalid'}`);

  const { idempotencyKey, operationId, phase, outcome, operation, occurredAt, principal, connectorId, permission } = input;
  if (!safeId(idempotencyKey)) return bad('idempotencyKey');
  if (!safeId(operationId)) return bad('operationId');
  if (typeof phase !== 'string' || !PHASES.has(phase)) return bad('phase');
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return bad('outcome');
  if (!PHASE_OUTCOMES[phase as AuditPhase].has(outcome)) return bad('outcome_for_phase');
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) return bad('operation');
  if (idempotencyKey !== `${operationId}:${phase}`) return bad('idempotencyKey_mismatch');
  if (typeof occurredAt !== 'string' || !ISO_TIME.test(occurredAt)) return bad('occurredAt');
  if (!safeId(connectorId)) return bad('connectorId');
  if (typeof permission !== 'string' || !PERMISSION.test(permission)) return bad('permission');
  if (!isRecord(principal) || !hasOnly(principal, ['kind', 'id', 'orgId'])) return bad('principal');
  if ((principal['kind'] !== 'human' && principal['kind'] !== 'service') || !safeId(principal['id'])) return bad('principal');
  if (principal['orgId'] !== undefined && !safeId(principal['orgId'])) return bad('principal');

  const out: Record<string, unknown> = {
    idempotencyKey,
    operationId,
    phase,
    outcome,
    operation,
    occurredAt,
    principal: Object.freeze({
      kind: principal['kind'],
      id: principal['id'],
      ...(principal['orgId'] !== undefined ? { orgId: principal['orgId'] } : {}),
    }),
    connectorId,
    permission,
  };

  if (input['connectorVersion'] !== undefined) {
    if (typeof input['connectorVersion'] !== 'string' || !VERSION.test(input['connectorVersion'])) return bad('connectorVersion');
    out['connectorVersion'] = input['connectorVersion'];
  }
  if (input['sourceId'] !== undefined) {
    if (!safeId(input['sourceId'])) return bad('sourceId');
    out['sourceId'] = input['sourceId'];
  }
  for (const key of ['requestedScope', 'grantedScope'] as const) {
    if (input[key] !== undefined) {
      const ref = normalizeScopeRef(input[key]);
      if (ref === undefined) return bad(key);
      out[key] = Object.freeze(ref);
    }
  }
  if (input['decision'] !== undefined) {
    const d = input['decision'];
    if (!isRecord(d) || !hasOnly(d, ['effect', 'authority', 'policyId', 'lifetime', 'reasonCode'])) return bad('decision');
    if (d['effect'] !== 'allow' && d['effect'] !== 'deny' && d['effect'] !== 'prompt') return bad('decision.effect');
    if (d['authority'] !== 'platform' && d['authority'] !== 'development_unverified' && d['authority'] !== 'none')
      return bad('decision.authority');
    if (d['policyId'] !== undefined && !safeId(d['policyId'])) return bad('decision.policyId');
    if (d['lifetime'] !== undefined && d['lifetime'] !== 'once' && d['lifetime'] !== 'session' && d['lifetime'] !== 'persistent')
      return bad('decision.lifetime');
    if (d['reasonCode'] !== undefined && (typeof d['reasonCode'] !== 'string' || !ERROR_CODE.test(d['reasonCode'])))
      return bad('decision.reasonCode');
    out['decision'] = Object.freeze({
      effect: d['effect'],
      authority: d['authority'],
      ...(d['policyId'] !== undefined ? { policyId: d['policyId'] } : {}),
      ...(d['lifetime'] !== undefined ? { lifetime: d['lifetime'] } : {}),
      ...(d['reasonCode'] !== undefined ? { reasonCode: d['reasonCode'] } : {}),
    });
  }
  if (input['errorCode'] !== undefined) {
    if (typeof input['errorCode'] !== 'string' || !ERROR_CODE.test(input['errorCode'])) return bad('errorCode');
    out['errorCode'] = input['errorCode'];
  }
  if (input['counts'] !== undefined) {
    const c = input['counts'];
    if (!isRecord(c) || !hasOnly(c, ['evidence', 'skipped', 'errors', 'requestedKeys'])) return bad('counts');
    const counts: Record<string, number> = {};
    for (const key of Object.keys(c)) {
      if (!count(c[key])) return bad(`counts.${key}`);
      counts[key] = c[key];
    }
    out['counts'] = Object.freeze(counts);
  }
  if (input['partial'] !== undefined) {
    if (typeof input['partial'] !== 'boolean') return bad('partial');
    out['partial'] = input['partial'];
  }
  if (input['evidenceIds'] !== undefined) {
    const ids = input['evidenceIds'];
    if (!Array.isArray(ids) || ids.length > MAX_EVIDENCE_IDS || !ids.every(safeId)) return bad('evidenceIds');
    out['evidenceIds'] = Object.freeze([...(ids as string[])]);
  }
  if (input['keysDigest'] !== undefined) {
    if (typeof input['keysDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input['keysDigest'])) return bad('keysDigest');
    out['keysDigest'] = input['keysDigest'];
  }
  return ok(Object.freeze(out) as unknown as AuditRecordRequest);
}

/** Opaque, stable reference for a scope. The scope (often an absolute host path) is hashed, never recorded. */
export function scopeRef(scope: PermissionScope): AuditScopeRef | undefined {
  if (scope.kind !== 'path' && scope.kind !== 'resource') return undefined;
  return { kind: scope.kind, ref: `scp_${stableDigest([scopeKey(scope)]).slice(0, 32)}` };
}

/** A log-safe identifier: the value itself when it already fits the safe alphabet, otherwise a short digest of it. */
export function safeIdentifier(value: string): string {
  return SAFE_ID.test(value) ? value : `h_${stableDigest([value]).slice(0, 24)}`;
}

/** Digest of a list of resource keys, order-independent. The keys are source-relative paths and are not recorded. */
export function digestKeys(keys: readonly string[]): string {
  return `sha256:${createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex')}`;
}

/** True only for a receipt that is well-formed AND names the event that was submitted. Anything else is "not accepted". */
export function isReceiptFor(receipt: unknown, request: AuditRecordRequest): receipt is AuditReceipt {
  if (!isRecord(receipt)) return false;
  return (
    typeof receipt['eventId'] === 'string' &&
    receipt['eventId'].length > 0 &&
    Number.isSafeInteger(receipt['sequence']) &&
    (receipt['sequence'] as number) >= 1 &&
    typeof receipt['recordedAt'] === 'string' &&
    receipt['idempotencyKey'] === request.idempotencyKey &&
    receipt['outcome'] === request.outcome &&
    typeof receipt['duplicate'] === 'boolean'
  );
}

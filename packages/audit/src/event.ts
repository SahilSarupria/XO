import { AuditError, ErrorCode } from '@xo/errors';
import { isAuthenticatedPrincipal, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';

/** Schema version of the persisted event. Bump (and add a reader migration) on any breaking field change. */
export const AUDIT_SCHEMA_VERSION = 1 as const;

export const AUDIT_EVENT_TYPES = [
  'access.attempted',
  'access.denied',
  'authorization.denied',
  'execution.attempted',
  'execution.denied',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.waiting_for_human',
  'workflow.attempted',
  'workflow.denied',
  'workflow.started',
  'workflow.resumed',
  'workflow.step.completed',
  'workflow.step.failed',
  'workflow.completed',
  'workflow.failed',
  'workflow.waiting_for_human',
  'humantask.attempted',
  'humantask.denied',
  'humantask.resolved',
  'humantask.failed',
  'idempotency.replayed',
  'idempotency.recovered',
  'idempotency.conflict',
  'idempotency.in_progress',
  'idempotency.indeterminate',
  'approval.attempted',
  'approval.granted',
  'approval.denied',
  'audit.read',
  'audit.purged',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_OUTCOMES = ['attempted', 'allowed', 'denied', 'started', 'completed', 'failed', 'cancelled'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_TARGET_KINDS = [
  'workspace',
  'execution',
  'workflow',
  'workflow-execution',
  'workflow-step',
  'capability',
  'compilation',
  'source',
  'human-task',
  'audit-log',
] as const;
export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

/** Data classification of every audit record. Audit data is never ordinary application content. */
export const AUDIT_CLASSIFICATION = 'restricted' as const;

export interface AuditActorFields {
  readonly kind: 'human' | 'service' | 'system' | 'anonymous';
  readonly id?: string;
  readonly orgId?: string;
}

/**
 * Opaque, trusted actor reference. Only {@link actorFromPrincipal},
 * {@link SYSTEM_ACTOR} and {@link ANONYMOUS_ACTOR} mint one; a request body,
 * JSON copy or object literal is rejected by {@link validateDraft}. This is how
 * "request data cannot inject trusted actor identity" is enforced.
 */
export type AuditActor = AuditActorFields & { readonly __auditActor: true };

const mintedActors = new WeakSet<object>();
function mintActor(fields: AuditActorFields): AuditActor {
  const actor = Object.freeze({ ...fields }) as AuditActor;
  mintedActors.add(actor);
  return actor;
}

/** The actor for an event initiated by a VERIFIED principal. Throws for anything that is not an `AuthenticatedPrincipal`. */
export function actorFromPrincipal(principal: Principal): AuditActor {
  if (!isAuthenticatedPrincipal(principal)) {
    throw new AuditError(ErrorCode.AUDIT_EVENT_INVALID, 'audit actor requires a verified (authenticated) principal');
  }
  return mintActor({ kind: principal.kind, id: principal.id, ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}) });
}
/** Trusted-host-initiated work with no principal (e.g. the local CLI operator context). Not an identity. */
export const SYSTEM_ACTOR: AuditActor = mintActor({ kind: 'system' });
/** An unauthenticated or unverifiable caller (e.g. a failed authentication). Carries no id. */
export const ANONYMOUS_ACTOR: AuditActor = mintActor({ kind: 'anonymous' });

export interface AuditTarget {
  readonly kind: AuditTargetKind;
  readonly id: string;
  readonly workspaceId?: string;
}

export type AuditMetadataValue = string | number | boolean;

/** What producing code supplies. It deliberately has NO id, timestamp, sequence, retention or receipt field — those are the trusted store's. */
export interface AuditEventDraft {
  readonly type: AuditEventType;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly target?: AuditTarget;
  readonly correlationId?: string;
  readonly executionId?: string;
  /** Stable, sanitized code for a denial/failure (e.g. an `ErrorCode` value). Never a free-text message. */
  readonly reasonCode?: string;
  /** Minimal, sanitized, flat metadata. See {@link validateDraft} for the exact rules. */
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
  /** Optional dedupe key: a retried append with the same key is recorded once. */
  readonly idempotencyKey?: string;
}

export interface AuditEvent {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  readonly eventId: string;
  /** Strictly increasing per store, assigned under the store's write lock. Gaps appear only after an authorized purge. */
  readonly seq: number;
  /** Assigned by the store's trusted clock at append time. */
  readonly recordedAt: string;
  /** Earliest time the record may be purged (recordedAt + configured default retention). */
  readonly retainUntil: string;
  readonly classification: typeof AUDIT_CLASSIFICATION;
  readonly type: AuditEventType;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActorFields;
  readonly target?: AuditTarget;
  readonly correlationId?: string;
  readonly executionId?: string;
  readonly reasonCode?: string;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
  readonly idempotencyKey?: string;
}

// ── validation / sanitization ──────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ACTION_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
const META_KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_META_KEYS = new Set([
  'eventid',
  'seq',
  'recordedat',
  'retainuntil',
  'receipt',
  'actor',
  'schemaversion',
  'classification',
  'outcome',
  'type',
  'durable',
  'guarantee',
]);
const FORBIDDEN_KEY_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'apikey',
  'privatekey',
  'prompt',
  'response',
  'payload',
  'body',
  'content',
  'document',
  'input',
  'output',
  'bearer',
  'cookie',
  'session',
];
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /bearer\s+\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT-like
  /\b(sk|pk|xo|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/i, // provider/API-key-like
  /[A-Za-z0-9+/_=-]{40,}/, // long opaque blob (key, hash-of-secret, base64 document)
];
const MAX_META_KEYS = 16;
const MAX_META_STRING = 128;
const DRAFT_KEYS = new Set([
  'type',
  'action',
  'outcome',
  'actor',
  'target',
  'correlationId',
  'executionId',
  'reasonCode',
  'metadata',
  'idempotencyKey',
]);
const TARGET_KEYS = new Set(['kind', 'id', 'workspaceId']);

const TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
const OUTCOME_SET: ReadonlySet<string> = new Set(AUDIT_OUTCOMES);
const TARGET_KIND_SET: ReadonlySet<string> = new Set(AUDIT_TARGET_KINDS);

function bad(reason: string): Result<never, AuditError> {
  // The reason names the FIELD, never the offending value, so a rejected secret is not echoed into logs/errors.
  return err(new AuditError(ErrorCode.AUDIT_EVENT_INVALID, `invalid audit event: ${reason}`));
}

export function isTrustedActor(value: unknown): value is AuditActor {
  return typeof value === 'object' && value !== null && mintedActors.has(value);
}

/** Validates a draft. Returns a normalized plain copy (never the caller's mutable object). */
export function validateDraft(draft: unknown): Result<AuditEventDraft, AuditError> {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return bad('draft must be an object');
  const d = draft as Record<string, unknown>;
  for (const key of Object.keys(d)) if (!DRAFT_KEYS.has(key)) return bad(`unknown field "${key.slice(0, 40)}"`);

  if (typeof d['type'] !== 'string' || !TYPE_SET.has(d['type'])) return bad('type is not a known audit event type');
  if (typeof d['outcome'] !== 'string' || !OUTCOME_SET.has(d['outcome'])) return bad('outcome is not a known outcome');
  if (typeof d['action'] !== 'string' || !ACTION_RE.test(d['action'])) return bad('action is malformed');
  if (!isTrustedActor(d['actor']))
    return bad('actor must be a trusted actor reference (actorFromPrincipal / SYSTEM_ACTOR / ANONYMOUS_ACTOR)');

  const out: {
    -readonly [K in keyof AuditEventDraft]: AuditEventDraft[K];
  } = {
    type: d['type'] as AuditEventType,
    action: d['action'],
    outcome: d['outcome'] as AuditOutcome,
    actor: d['actor'],
  };

  if (d['target'] !== undefined) {
    const t = d['target'];
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return bad('target must be an object');
    const tr = t as Record<string, unknown>;
    for (const key of Object.keys(tr)) if (!TARGET_KEYS.has(key)) return bad('target has an unknown field');
    if (typeof tr['kind'] !== 'string' || !TARGET_KIND_SET.has(tr['kind'])) return bad('target.kind is not a known kind');
    if (typeof tr['id'] !== 'string' || !ID_RE.test(tr['id'])) return bad('target.id is malformed');
    if (tr['workspaceId'] !== undefined && (typeof tr['workspaceId'] !== 'string' || !ID_RE.test(tr['workspaceId'])))
      return bad('target.workspaceId is malformed');
    out.target = {
      kind: tr['kind'] as AuditTargetKind,
      id: tr['id'],
      ...(typeof tr['workspaceId'] === 'string' ? { workspaceId: tr['workspaceId'] } : {}),
    };
  }
  for (const field of ['correlationId', 'executionId', 'idempotencyKey'] as const) {
    const v = d[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ID_RE.test(v)) return bad(`${field} is malformed`);
    out[field] = v;
  }
  if (d['reasonCode'] !== undefined) {
    if (typeof d['reasonCode'] !== 'string' || !REASON_RE.test(d['reasonCode'])) return bad('reasonCode is malformed');
    out.reasonCode = d['reasonCode'];
  }
  if (d['metadata'] !== undefined) {
    const m = d['metadata'];
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return bad('metadata must be a flat object');
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length > MAX_META_KEYS) return bad('metadata has too many keys');
    const clean: Record<string, AuditMetadataValue> = {};
    for (const [k, v] of entries) {
      if (!META_KEY_RE.test(k)) return bad('a metadata key is malformed');
      const lower = k.toLowerCase();
      if (RESERVED_META_KEYS.has(lower)) return bad('a metadata key is reserved for trusted fields');
      if (FORBIDDEN_KEY_FRAGMENTS.some((f) => lower.includes(f))) return bad('a metadata key names forbidden (sensitive) content');
      if (typeof v === 'boolean') clean[k] = v;
      else if (typeof v === 'number') {
        if (!Number.isFinite(v)) return bad('a metadata number is not finite');
        clean[k] = v;
      } else if (typeof v === 'string') {
        if (v.length > MAX_META_STRING) return bad('a metadata string is too long');
        if (/[\r\n]/.test(v)) return bad('a metadata string contains a line break');
        if (SECRET_VALUE_PATTERNS.some((re) => re.test(v))) return bad('a metadata value looks like a secret or an opaque blob');
        clean[k] = v;
      } else return bad('metadata values must be string, number or boolean');
    }
    out.metadata = Object.freeze(clean);
  }
  return ok(Object.freeze(out));
}

export { isAuditData } from '@xo/types';

import { AuditError, ErrorCode } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { AUDIT_EVENT_TYPES, AUDIT_LIFECYCLE_PHASES, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS } from './vocab.js';
import type {
  AuditActor,
  AuditEventDraft,
  AuditEventType,
  AuditLifecyclePhase,
  AuditMetadataValue,
  AuditOutcome,
  AuditTargetKind,
} from './event.js';
import { validateExtensionValue, type AuditExtensionSchemas, type GlobalFilters } from './extension.js';

/** INTERNAL (not exported from index.ts): the single implementation of draft validation and sanitization. */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ACTION_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
const META_KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_META_KEYS: ReadonlySet<string> = new Set([
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
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
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
export const FILTERS: GlobalFilters = {
  forbiddenKeyFragments: FORBIDDEN_KEY_FRAGMENTS,
  reservedKeys: RESERVED_META_KEYS,
  secretValuePatterns: SECRET_VALUE_PATTERNS,
};
const PHASE_SET: ReadonlySet<string> = new Set(AUDIT_LIFECYCLE_PHASES);
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
  'lifecycle',
  'extensions',
]);
const TARGET_KEYS = new Set(['kind', 'id', 'workspaceId']);

const TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
const OUTCOME_SET: ReadonlySet<string> = new Set(AUDIT_OUTCOMES);
const TARGET_KIND_SET: ReadonlySet<string> = new Set(AUDIT_TARGET_KINDS);

function bad(reason: string): Result<never, AuditError> {
  // The reason names the FIELD, never the offending value, so a rejected secret is not echoed into logs/errors.
  return err(new AuditError(ErrorCode.AUDIT_EVENT_INVALID, `invalid audit event: ${reason}`));
}

export interface ValidateContext {
  readonly actorOk: (value: unknown) => boolean;
  readonly extensionSchemas: AuditExtensionSchemas;
}

/** Shared validation. `actorOk` differs between a live draft (must be minted) and re-validation of a persisted event. */
export function validateDraftFields(draft: unknown, ctx: ValidateContext): Result<AuditEventDraft, AuditError> {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return bad('draft must be an object');
  const d = draft as Record<string, unknown>;
  for (const key of Object.keys(d)) if (!DRAFT_KEYS.has(key)) return bad(`unknown field "${key.slice(0, 40)}"`);

  if (typeof d['type'] !== 'string' || !TYPE_SET.has(d['type'])) return bad('type is not a known audit event type');
  if (typeof d['outcome'] !== 'string' || !OUTCOME_SET.has(d['outcome'])) return bad('outcome is not a known outcome');
  if (typeof d['action'] !== 'string' || !ACTION_RE.test(d['action'])) return bad('action is malformed');
  if (!ctx.actorOk(d['actor'])) return bad('actor must be a trusted actor reference (actorFromPrincipal / SYSTEM_ACTOR / ANONYMOUS_ACTOR)');

  const out: {
    -readonly [K in keyof AuditEventDraft]: AuditEventDraft[K];
  } = {
    type: d['type'] as AuditEventType,
    action: d['action'],
    outcome: d['outcome'] as AuditOutcome,
    actor: d['actor'] as AuditActor,
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
  if (d['lifecycle'] !== undefined) {
    const l = d['lifecycle'];
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return bad('lifecycle must be an object');
    const lr = l as Record<string, unknown>;
    for (const key of Object.keys(lr)) if (key !== 'operationId' && key !== 'phase') return bad('lifecycle has an unknown field');
    if (typeof lr['operationId'] !== 'string' || !ID_RE.test(lr['operationId'])) return bad('lifecycle.operationId is malformed');
    if (typeof lr['phase'] !== 'string' || !PHASE_SET.has(lr['phase'])) return bad('lifecycle.phase is not a known phase');
    out.lifecycle = Object.freeze({ operationId: lr['operationId'], phase: lr['phase'] as AuditLifecyclePhase });
  }
  if (d['extensions'] !== undefined) {
    const e = d['extensions'];
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return bad('extensions must be an object');
    const cleanExt: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [ns, value] of Object.entries(e as Record<string, unknown>)) {
      const schema = ctx.extensionSchemas[ns];
      if (schema === undefined) return bad('an extension namespace is not registered with this store');
      const r = validateExtensionValue(schema, value, FILTERS);
      if (!r.ok) return r;
      cleanExt[ns] = r.value;
    }
    out.extensions = Object.freeze(cleanExt);
  }
  return ok(Object.freeze(out));
}

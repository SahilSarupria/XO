import { createHash } from 'node:crypto';

/**
 * One workspace audit entry. The log is append-only and hash-chained: every entry carries the hash of the entry
 * before it, so removing, reordering or editing any stored entry is detectable by `FsAuditLog.verify()`.
 *
 * "Tamper-evident", not "tamper-proof": someone with write access to the storage directory can rewrite the *whole*
 * chain consistently. What the chain guarantees is that a partial edit cannot go unnoticed, and (via `headHash`,
 * which an exporter can publish elsewhere) that a full rewrite is detectable against an externally held head.
 */

export const AUDIT_EVENTS = [
  'workspace.created',
  'workspace.updated',
  'member.added',
  'member.role_changed',
  'member.removed',
  'settings.updated',
  'source.uploaded',
  'source.imported',
  'source.deleted',
  'compilation.started',
  'capability.approved',
  'execution.created',
  'execution.test_run',
  'human_task.resolved',
  'human_task.info_requested',
  'workflow.started',
  'workflow.resumed',
  'workflow.definition_saved',
  'workflow.definition_deleted',
  'xo.published',
  'xo.installed',
  'xo.uninstalled',
  'chat.message',
  'access.denied',
  'audit.exported',
] as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === 'string' && (AUDIT_EVENTS as readonly string[]).includes(value);
}

export const AUDIT_RESULTS = ['succeeded', 'failed', 'denied', 'escalated', 'approved', 'rejected'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export function isAuditResult(value: unknown): value is AuditResult {
  return typeof value === 'string' && (AUDIT_RESULTS as readonly string[]).includes(value);
}

export interface AuditActor {
  readonly identityId: string;
  /** `system` = the server itself acting (e.g. a workflow step) with no human or service credential behind it. */
  readonly kind: 'user' | 'service' | 'system';
  /** Role held in the workspace at the time of the event. */
  readonly role?: string;
  readonly displayName?: string;
}

export interface AuditTarget {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
}

/** What a caller supplies. Everything else (`seq`, time, hashes) is assigned by the log. */
export interface AuditEventInput {
  readonly event: AuditEventType;
  readonly actor: AuditActor;
  readonly target?: AuditTarget;
  readonly result: AuditResult;
  /** Small, JSON-serializable context. Never secrets, never document bodies. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditEntry extends AuditEventInput {
  readonly seq: number;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly at: string;
  /** `hash` of the entry before this one; `GENESIS_HASH` for seq 1. */
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively, `undefined` dropped. The hash input must not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(entry)).digest('hex')}`;
}

export interface AuditVerification {
  readonly ok: boolean;
  readonly entries: number;
  readonly headHash: string;
  /** First problem found, if any. */
  readonly brokenAt?: { readonly seq: number; readonly reason: 'missing_entry' | 'bad_hash' | 'bad_link' | 'bad_sequence' | 'unreadable' };
}

import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { parsePrincipal, type Principal } from '@xo/permissions';

/**
 * P1.0 M3 — Approval Integrity.
 *
 * An approval is a workspace-scoped, ATTRIBUTED and BOUND fact: "this authenticated principal approved THIS capability, in THIS
 * compilation, in THIS workspace, in THIS material state". It is deliberately still not a review workflow (no quorum, comments or
 * revocation) — M3 adds integrity to the existing record, it does not add features around it.
 *
 *  - Attributable: `approver` is a snapshot of the `AuthenticatedPrincipal` (M1) that made the call. It is never request data.
 *  - Bound: `binding` carries the capability's material-state digest at approval time (see `approval-binding.ts` for exactly what
 *    "material" covers: the contract's semantic content including its rules, the permission declaration, and the resolved binding).
 *  - Invalidated by material change: an approval is only honoured by {@link evaluateApproval} when the CURRENT state of the
 *    capability, derived by the enforcement point from the graph it is about to execute, still has the same digest.
 *
 * Fail closed: a missing, legacy (pre-M3, unbound), malformed, foreign, unattributed or stale record is "not approved". There is no
 * implicit upgrade of a legacy record — an approver must approve the capability again, against its current state.
 */
export const APPROVAL_SCHEMA_VERSION = 2 as const;

/** What an approval was bound to when it was granted. All fields are derived server-side from the persisted compilation. */
export interface ApprovalBinding {
  /** Digest over the capability's material state (the field that decides staleness). */
  readonly stateDigest: string;
  readonly contractId: string;
  readonly contractContentHash: string;
  readonly declarationFingerprint: string;
  readonly implementationClass: string;
  readonly bindingId: string;
  /** `CompilationRecord.sourceDigestSha256` at approval time — the exact source bytes the compilation ran against. */
  readonly sourceDigestSha256: string;
}

export interface ApprovalRecord {
  readonly schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly status: 'approved';
  readonly approvedAt: string;
  /** The authenticated principal that approved — a snapshot minted from `req.principal`, never client-supplied. */
  readonly approver: Principal;
  /** Equals `approver.id`; kept for continuity with pre-M3 consumers. Checked for agreement on every verification. */
  readonly identityId: string;
  /** Equals `approver.id`; same continuity note. */
  readonly approverIdentityId: string;
  readonly binding: ApprovalBinding;
}

/** What the approve route supplies; the store stamps `approvedAt` and `schemaVersion`. */
export interface ApprovalDraft {
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly approver: Principal;
  readonly binding: ApprovalBinding;
}

/** What a stored approval file turned out to be. A legacy or malformed file is never an approval. */
export type ApprovalLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'bound'; readonly record: ApprovalRecord };

/**
 * Scoped to exactly one workspace by construction (built from `workspaceApprovalsStore`). Callers must NOT decide "approved" from
 * a lookup themselves — only {@link evaluateApproval} does, against current state.
 */
export interface ApprovalStore {
  approve(draft: ApprovalDraft): Promise<Result<ApprovalRecord, XoError>>;
  /** `ok({ kind: 'none' })` (not an error) when no approval exists — "not approved" is a normal state. */
  lookup(compilationId: string, capabilityId: string): Promise<Result<ApprovalLookup, XoError>>;
}

/** The capability's current material state, as derived by the enforcement point (see `approval-binding.ts`). */
export interface CurrentApprovalState {
  readonly stateDigest: string;
  readonly contractId: string;
  readonly contractContentHash: string;
  readonly declarationFingerprint: string;
  readonly implementationClass: string;
  readonly bindingId: string;
  /** The compilation record's own `sourceDigestSha256`. */
  readonly sourceDigestSha256: string;
}

export interface ExpectedApprovalTarget {
  readonly workspaceId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
}

export type ApprovalDenialReason =
  'not_approved' | 'legacy_unbound' | 'malformed' | 'target_mismatch' | 'attribution_invalid' | 'stale' | 'state_unavailable';

/** Stable, audit-safe reason codes (match the audit `reasonCode` pattern). */
export const APPROVAL_REASON_CODES: Readonly<Record<ApprovalDenialReason, string>> = Object.freeze({
  // Unchanged from before M3 (M4's audit contract for an unapproved execution); the finer reasons below are new.
  not_approved: 'XO_RUNTIME_PERMISSION_DENIED',
  legacy_unbound: 'APPROVAL_LEGACY_UNBOUND',
  malformed: 'APPROVAL_MALFORMED',
  target_mismatch: 'APPROVAL_TARGET_MISMATCH',
  attribution_invalid: 'APPROVAL_ATTRIBUTION_INVALID',
  stale: 'APPROVAL_STALE',
  state_unavailable: 'APPROVAL_STATE_UNAVAILABLE',
});

export type ApprovalVerdict =
  | { readonly approved: true; readonly record: ApprovalRecord }
  | { readonly approved: false; readonly reason: ApprovalDenialReason; readonly reasonCode: string; readonly message: string };

function denied(reason: ApprovalDenialReason, message: string): ApprovalVerdict {
  return { approved: false, reason, reasonCode: APPROVAL_REASON_CODES[reason], message };
}

const STRING_FIELDS = ['compilationId', 'capabilityId', 'workspaceId', 'approvedAt', 'identityId', 'approverIdentityId'] as const;
const BINDING_FIELDS = [
  'stateDigest',
  'contractId',
  'contractContentHash',
  'declarationFingerprint',
  'implementationClass',
  'bindingId',
  'sourceDigestSha256',
] as const;
const RECORD_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'status', 'approver', 'binding', ...STRING_FIELDS]);
const BINDING_KEYS: ReadonlySet<string> = new Set(BINDING_FIELDS);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Strictly interprets one stored approval file. Unknown schema versions and unknown fields are `malformed` (never ignored), a
 * pre-M3 record (no `schemaVersion`, no binding) is `legacy`, and anything else that does not fully validate is `malformed`.
 */
export function parseApprovalRecord(raw: unknown): ApprovalLookup {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'malformed' };
  const o = raw as Record<string, unknown>;
  if (o['schemaVersion'] === undefined) {
    // The pre-M3 shape: an approved flag with no binding. Recognised only to be refused with a precise reason.
    return o['status'] === 'approved' && o['binding'] === undefined ? { kind: 'legacy' } : { kind: 'malformed' };
  }
  if (o['schemaVersion'] !== APPROVAL_SCHEMA_VERSION) return { kind: 'malformed' };
  if (Object.keys(o).some((k) => !RECORD_KEYS.has(k))) return { kind: 'malformed' };
  if (o['status'] !== 'approved') return { kind: 'malformed' };
  for (const field of STRING_FIELDS) if (!isNonEmptyString(o[field])) return { kind: 'malformed' };

  const approver = parsePrincipal(o['approver']);
  if (!approver.ok) return { kind: 'malformed' };

  const b = o['binding'];
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { kind: 'malformed' };
  const binding = b as Record<string, unknown>;
  if (Object.keys(binding).some((k) => !BINDING_KEYS.has(k))) return { kind: 'malformed' };
  for (const field of BINDING_FIELDS) if (!isNonEmptyString(binding[field])) return { kind: 'malformed' };

  return {
    kind: 'bound',
    record: {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      compilationId: o['compilationId'] as string,
      capabilityId: o['capabilityId'] as string,
      workspaceId: o['workspaceId'] as string,
      status: 'approved',
      approvedAt: o['approvedAt'] as string,
      approver: approver.value,
      identityId: o['identityId'] as string,
      approverIdentityId: o['approverIdentityId'] as string,
      binding: Object.fromEntries(BINDING_FIELDS.map((f) => [f, binding[f]])) as unknown as ApprovalBinding,
    },
  };
}

/**
 * THE decision: is this capability approved FOR ITS CURRENT STATE, for this exact target? Pure and synchronous so every
 * enforcement point (execution route, workflow runner, human-task resume, projections) shares one implementation. Order matters
 * only for the reported reason; every branch other than the last is a denial.
 */
export function evaluateApproval(
  lookup: ApprovalLookup,
  expected: ExpectedApprovalTarget,
  current: CurrentApprovalState | undefined,
): ApprovalVerdict {
  const label = `capability "${expected.capabilityId}"`;
  switch (lookup.kind) {
    case 'none':
      return denied('not_approved', `${label} is not approved for execution in workspace "${expected.workspaceId}"`);
    case 'legacy':
      return denied(
        'legacy_unbound',
        `${label} has only a pre-approval-integrity approval that is not bound to a capability state; it must be approved again`,
      );
    case 'malformed':
      return denied('malformed', `${label} has an unreadable or invalid approval record and is treated as not approved`);
    case 'bound':
      break;
  }
  const record = lookup.record;

  if (
    record.workspaceId !== expected.workspaceId ||
    record.compilationId !== expected.compilationId ||
    record.capabilityId !== expected.capabilityId
  ) {
    return denied(
      'target_mismatch',
      `the approval on record is not for ${label} in compilation "${expected.compilationId}" of this workspace`,
    );
  }
  if (record.identityId !== record.approver.id || record.approverIdentityId !== record.approver.id) {
    return denied('attribution_invalid', `the approval for ${label} is not consistently attributed to a single approver`);
  }
  if (current === undefined) {
    return denied('state_unavailable', `the current state of ${label} could not be established, so its approval cannot be verified`);
  }
  const bound = record.binding;
  if (
    bound.stateDigest !== current.stateDigest ||
    bound.contractId !== current.contractId ||
    bound.contractContentHash !== current.contractContentHash ||
    bound.declarationFingerprint !== current.declarationFingerprint ||
    bound.implementationClass !== current.implementationClass ||
    bound.bindingId !== current.bindingId ||
    bound.sourceDigestSha256 !== current.sourceDigestSha256
  ) {
    return denied(
      'stale',
      `the approval for ${label} no longer matches its current state (it changed since it was approved); approve it again`,
    );
  }
  return { approved: true, record };
}

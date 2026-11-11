import { AuditError, ErrorCode } from '@xo/errors';
import { isAuthenticatedPrincipal, type Principal } from '@xo/permissions';
import type { Result } from '@xo/types';
import { canonicalJson } from './canonical.js';
import type { AuditExtensionSchemas } from './extension.js';
import { isMintedActor, mintActorInternal } from './trust.js';
import { validateDraftFields } from './validate.js';
import { AUDIT_EVENT_TYPES, AUDIT_LIFECYCLE_PHASES, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS } from './vocab.js';

export { AUDIT_EVENT_TYPES, AUDIT_LIFECYCLE_PHASES, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS };

/** Schema version of the persisted event. Bump (and add a reader migration) on any breaking field change. */
export const AUDIT_SCHEMA_VERSION = 1 as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

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

function mintActor(fields: AuditActorFields): AuditActor {
  return mintActorInternal(fields);
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

/** Lifecycle position of an event within one operation (C0.3). Enforced only by a store that supports lifecycle. */
export type AuditLifecyclePhase = (typeof AUDIT_LIFECYCLE_PHASES)[number];
export interface AuditLifecycle {
  readonly operationId: string;
  readonly phase: AuditLifecyclePhase;
}
/** Registered, schema-validated, closed extension payloads keyed by namespace (see `extension.ts`). */
export type AuditExtensions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

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
  /** Optional dedupe key: a retried append with the same key is recorded once; the same key with DIFFERENT content is a conflict. */
  readonly idempotencyKey?: string;
  /** Lifecycle ordering (attempt -> one terminal). Refused by stores that do not enforce it — never silently dropped. */
  readonly lifecycle?: AuditLifecycle;
  /** Registered closed extensions. Refused unless the store was opened with a schema for the namespace. */
  readonly extensions?: AuditExtensions;
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
  readonly lifecycle?: AuditLifecycle;
  readonly extensions?: AuditExtensions;
}

// ── validation (implementation in validate.ts; only the trusted-actor-checking entry points are public) ──

export function isTrustedActor(value: unknown): value is AuditActor {
  return isMintedActor(value);
}

export interface ValidateDraftOptions {
  /** Extension schemas the validating store was opened with. Without one, a draft carrying `extensions` is rejected. */
  readonly extensionSchemas?: AuditExtensionSchemas;
}

/** Validates a draft. Returns a normalized plain copy (never the caller's mutable object). */
export function validateDraft(draft: unknown, options: ValidateDraftOptions = {}): Result<AuditEventDraft, AuditError> {
  return validateDraftFields(draft, { actorOk: isMintedActor, extensionSchemas: options.extensionSchemas ?? {} });
}

/**
 * Identity of a draft's CONTENT for idempotency/conflict detection. Trusted, store-assigned fields (id, seq, time,
 * retention) and the idempotency key itself are excluded: a retry of the same logical event, later, is the same event.
 */
export function auditContentDigest(content: {
  readonly type: string;
  readonly action: string;
  readonly outcome: string;
  readonly actor: AuditActorFields;
  readonly target?: AuditTarget | undefined;
  readonly correlationId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>> | undefined;
  readonly lifecycle?: AuditLifecycle | undefined;
  readonly extensions?: AuditExtensions | undefined;
}): string {
  const { type, action, outcome, actor, target, correlationId, executionId, reasonCode, metadata, lifecycle, extensions } = content;
  return canonicalJson({
    type,
    action,
    outcome,
    actor: { kind: actor.kind, id: actor.id, orgId: actor.orgId },
    target,
    correlationId,
    executionId,
    reasonCode,
    metadata,
    lifecycle,
    extensions,
  });
}

export { isAuditData } from '@xo/types';

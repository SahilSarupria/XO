import { ErrorCode, XoError } from '@xo/errors';
import { parsePrincipal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { ApiKeyRecord, ApiKeyStore } from './api-key-store.interface.js';
import { generateApiKey, hashApiKey } from './api-key.js';

/**
 * UW-1 — the API key lifecycle: issue (with an expiry), rotate, revoke. Operator-side only (used by `scripts/manage-keys.ts`); no route
 * issues keys. The raw key is returned exactly once and never persisted (only its hash is).
 */

/** Default lifetime of a newly issued key. */
export const DEFAULT_KEY_LIFETIME_DAYS = 90;
/** Upper bound on a requested lifetime; a longer-lived credential needs a deliberate rotation instead. */
export const MAX_KEY_LIFETIME_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IssueKeyInput {
  readonly identityId: string;
  /** No default: the operator states the principal kind every time. */
  readonly kind: unknown;
  readonly orgId?: string;
  readonly creatorDid?: string;
  /** Default {@link DEFAULT_KEY_LIFETIME_DAYS}; must be a positive integer up to {@link MAX_KEY_LIFETIME_DAYS}. */
  readonly expiresInDays?: number;
  readonly now?: () => Date;
}

export interface IssuedKey {
  /** Shown once to the operator, never stored. */
  readonly rawKey: string;
  readonly record: ApiKeyRecord;
}

function invalid(message: string): XoError {
  return new XoError(ErrorCode.INVALID_ARGUMENT, message);
}

function buildRecord(input: IssueKeyInput): Result<IssuedKey, XoError> {
  const principal = parsePrincipal({
    kind: input.kind,
    id: input.identityId,
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
  });
  if (!principal.ok) return err(principal.error);
  const days = input.expiresInDays ?? DEFAULT_KEY_LIFETIME_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_LIFETIME_DAYS) {
    return err(invalid(`key lifetime must be a whole number of days from 1 to ${MAX_KEY_LIFETIME_DAYS}`));
  }
  const now = (input.now ?? (() => new Date()))();
  const rawKey = generateApiKey();
  return ok({
    rawKey,
    record: {
      keyHash: hashApiKey(rawKey),
      identityId: principal.value.id,
      principalKind: principal.value.kind,
      ...(principal.value.orgId !== undefined ? { orgId: principal.value.orgId } : {}),
      ...(input.creatorDid !== undefined ? { creatorDid: input.creatorDid } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
    },
  });
}

/** Issue one new key bound to a principal, with an expiry. */
export async function issueApiKey(store: ApiKeyStore, input: IssueKeyInput): Promise<Result<IssuedKey, XoError>> {
  const built = buildRecord(input);
  if (!built.ok) return built;
  const created = await store.create(built.value.record);
  if (!created.ok) return err(created.error);
  return built;
}

export interface RotatedKey extends IssuedKey {
  /** Hashes of the keys this rotation revoked, for the operator's record of the rotation. */
  readonly revokedKeyHashes: readonly string[];
}

/**
 * Rotate an identity's credentials: issue a new key FIRST, then revoke every other active key of that identity. Issuing first means a
 * failure leaves the old keys working (no lock-out); the reverse order could leave an identity with no key at all. The result lists the
 * hashes of the revoked keys so the operator can record which credentials the new key replaced.
 */
export async function rotateApiKeys(store: ApiKeyStore, input: IssueKeyInput): Promise<Result<RotatedKey, XoError>> {
  const issued = await issueApiKey(store, input);
  if (!issued.ok) return issued;
  const revoked = await store.revokeByIdentity(input.identityId, { exceptKeyHash: issued.value.record.keyHash });
  if (!revoked.ok) return err(revoked.error);
  return ok({ ...issued.value, revokedKeyHashes: revoked.value.revokedKeyHashes });
}

import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

/**
 * What's actually persisted for one issued API key. `keyHash` (never the
 * raw key — see `api-key.ts`'s `hashApiKey`) doubles as the record's
 * storage key in `FsApiKeyStore`, so lookup-by-hash is a direct read,
 * not a scan.
 */
export interface ApiKeyRecord {
  readonly keyHash: string;
  readonly identityId: string;
  /** See `identity.ts`'s `ApiKeyIdentity.creatorDid` doc comment. */
  readonly creatorDid?: string;
  readonly createdAt: string;
  /** Unset for an active key; set (ISO timestamp) once revoked. Revocation marks in place — a record is never deleted, so "was this key ever valid, and when did it stop being" stays answerable. */
  readonly revokedAt?: string;
}

/**
 * Persistence port for API keys, following the same `Result`-returning,
 * `BlobStore`-backed shape `@xo/registry-core`'s repository interfaces
 * use (see `LicenseRepository`) — `FsApiKeyStore` is this interface's
 * one real implementation, matching `FsLicenseRepository`.
 */
export interface ApiKeyStore {
  /** Fails with a generic `ALREADY_EXISTS` `XoError` if a record already exists for this exact `keyHash` — practically unreachable for two distinct raw keys (256 bits of entropy), kept as a defensive check rather than a silent overwrite. */
  create(record: ApiKeyRecord): Promise<Result<void, XoError>>;

  /** The auth middleware's hot path — looked up once per authenticated request. `NotFoundError` for a hash that doesn't match any issued key (never distinguishes "never existed" from "revoked" here — the middleware checks `revokedAt` on the returned record for that). */
  findByHash(keyHash: string): Promise<Result<ApiKeyRecord, NotFoundError>>;

  /** Marks every currently-active key belonging to `identityId` as revoked (idempotent — re-revoking an already-revoked key is a no-op, not an error). `NotFoundError` only when `identityId` has no key record at all, active or revoked. */
  revokeByIdentity(identityId: string): Promise<Result<{ readonly revokedCount: number }, XoError>>;
}

import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';

/**
 * Server-side authorization record: "this verified (issuer, subject) acts as
 * this XO principal". Written only by the operator path
 * (`scripts/manage-bindings.ts`); never by a request, a token claim, or Studio.
 *
 * `identityId` is the principal's stable XO id and is what workspace
 * ownership and execution records attribute to. It may equal an id that API
 * keys also use; that is the operator's decision and lets one person hold
 * both credential types.
 */
export interface IdentityBinding {
  /** Stable id derived from (issuer, subject): `computeBindingId`. Not a secret. */
  readonly bindingId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly identityId: string;
  readonly principalKind: 'human' | 'service';
  /** Optional organizational scope label. NOT proof of membership or authorization. */
  readonly orgId?: string;
  readonly createdAt: string;
  /** Set (ISO timestamp) once revoked. Revocation marks in place; the record is kept. */
  readonly revokedAt?: string;
}

export interface IdentityBindingStore {
  /** Fails `ALREADY_EXISTS` if an active binding exists for this (issuer, subject). Replaces a revoked one (explicit operator re-binding). */
  create(binding: IdentityBinding): Promise<Result<void, XoError>>;
  /** `undefined` means no record. A corrupt record is also reported as no record (fail closed). */
  find(issuer: string, subject: string): Promise<Result<IdentityBinding | undefined, XoError>>;
  /** Idempotent. `NotFoundError` only if no record exists at all. */
  revoke(issuer: string, subject: string): Promise<Result<{ readonly alreadyRevoked: boolean }, XoError>>;
  /** Every record, active and revoked (operator listing). */
  list(): Promise<Result<readonly IdentityBinding[], XoError>>;
}

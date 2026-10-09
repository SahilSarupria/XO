import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, XoError } from '@xo/errors';

/**
 * P1.0 M1 — the initiating actor of a protected execution.
 *
 * A `Principal` answers exactly one question: "who initiated this?". It
 * is deliberately NOT a requester (`PermissionRequester` — the package /
 * capability asking for a permission), NOT a grant, NOT a role, and NOT
 * proof of organizational membership. Possessing a `Principal` — or an
 * `orgId` on one — confers no authority whatsoever; authorization is a
 * separate decision (P1.0 M2).
 *
 * Authenticated identity vs. attribution:
 *   - `Principal`              — a validated *shape*. Anything (a stored
 *     record, a request body) can be parsed into one. It is attribution
 *     data, never proof of identity.
 *   - `AuthenticatedPrincipal` — a `Principal` that was minted by
 *     {@link establishAuthenticatedPrincipal}, which only a trusted
 *     authentication boundary (today: API-key authentication in
 *     `apps/api/src/http/auth.ts`) is meant to call. Protected paths
 *     accept only this type and re-check it at runtime with
 *     {@link isAuthenticatedPrincipal}, so a Principal deserialized from
 *     JSON, a header, or a body cannot be passed off as authenticated.
 *
 * Limitation (documented, not hidden): the marker is an in-process
 * guarantee. It prevents accidental/injected data from posing as an
 * authenticated principal; it cannot stop other code in the same process
 * from calling the factory. The trust boundary is therefore "which code
 * calls `establishAuthenticatedPrincipal`", and that is a reviewable,
 * single call site.
 */
export const PRINCIPAL_KINDS = ['human', 'service'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface Principal {
  readonly kind: PrincipalKind;
  /** Stable identity established by the authenticating boundary. Opaque; never a package or capability id. */
  readonly id: string;
  /** Optional organizational scope. A label only — NOT proof of membership or authorization. */
  readonly orgId?: string;
}

declare const authenticatedBrand: unique symbol;
export type AuthenticatedPrincipal = Principal & { readonly [authenticatedBrand]: true };

/** Conservative, log-safe, path-safe identifier: starts alphanumeric, then [A-Za-z0-9._:@-], max 128. */
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'id', 'orgId']);

function invalid(message: string): Result<never, XoError> {
  return err(new XoError(ErrorCode.INVALID_ARGUMENT, `invalid principal: ${message}`));
}

/**
 * Validates and normalizes untrusted input into a frozen `Principal`.
 * Unknown fields are rejected (not ignored) so authority-like extras
 * (`roles`, `grants`, `admin`, ...) can never ride along on a principal.
 * Does NOT make the result authenticated.
 */
export function parsePrincipal(input: unknown): Result<Principal, XoError> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('must be an object');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return invalid(`unknown field "${key}"`);
  }
  const { kind, id, orgId } = record;
  if (typeof kind !== 'string' || !(PRINCIPAL_KINDS as readonly string[]).includes(kind)) return invalid(`"kind" must be one of ${PRINCIPAL_KINDS.join(', ')}`);
  if (typeof id !== 'string' || !PRINCIPAL_ID_PATTERN.test(id)) return invalid('"id" must be a non-empty identifier of letters, digits and . _ : @ - (max 128 characters)');
  if (orgId !== undefined && (typeof orgId !== 'string' || !PRINCIPAL_ID_PATTERN.test(orgId))) return invalid('"orgId", when present, must be a non-empty identifier of letters, digits and . _ : @ - (max 128 characters)');
  return ok(Object.freeze({ kind: kind as PrincipalKind, id, ...(orgId !== undefined ? { orgId } : {}) }));
}

const authenticated = new WeakSet<object>();

/**
 * Mints an `AuthenticatedPrincipal`. Call ONLY from a trusted
 * authentication boundary, with identity material the server itself
 * resolved (e.g. a key-store record) — never with data taken from a
 * request body, header, query string, environment variable or CLI flag.
 */
export function establishAuthenticatedPrincipal(input: unknown): Result<AuthenticatedPrincipal, XoError> {
  const parsed = parsePrincipal(input);
  if (!parsed.ok) return parsed;
  const minted = Object.freeze({ ...parsed.value }) as AuthenticatedPrincipal;
  authenticated.add(minted);
  return ok(minted);
}

/** True only for objects minted by {@link establishAuthenticatedPrincipal} in this process. A structurally identical copy is NOT authenticated. */
export function isAuthenticatedPrincipal(value: unknown): value is AuthenticatedPrincipal {
  return typeof value === 'object' && value !== null && authenticated.has(value);
}

/** Fail-closed guard for protected paths. Throws `XoError` unless `value` is an `AuthenticatedPrincipal`. */
export function assertAuthenticatedPrincipal(value: unknown): asserts value is AuthenticatedPrincipal {
  if (!isAuthenticatedPrincipal(value)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'protected execution requires an authenticated principal');
  }
}

/** The plain attribution snapshot persisted on records — a `Principal`, never an authenticated one. */
export function toPrincipalSnapshot(principal: Principal): Principal {
  return Object.freeze({ kind: principal.kind, id: principal.id, ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}) });
}

export function principalsEqual(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id && a.orgId === b.orgId;
}

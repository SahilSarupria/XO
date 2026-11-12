import { createRemoteJWKSet, errors as joseErrors } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { AuthError, ErrorCode } from '@xo/errors';
import { assertTrustedUrl } from './config.js';

/**
 * Shared by the access-token verifier and the ID-token verifier: how a trusted issuer's signing keys are
 * located (discovery or an explicit URL), cached, refreshed and classified when they fail. Nothing here
 * knows what kind of token is being verified, and nothing here accepts an issuer or key location that the
 * operator did not configure.
 */

export const MAX_DISCOVERY_BYTES = 64 * 1024;
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Timing/limits that tests tighten; production uses the defaults. */
export interface VerifierTuning {
  /** Per-request network timeout for discovery and JWKS fetches. */
  readonly httpTimeoutMs?: number;
  /** Minimum gap between JWKS refetches triggered by an unknown `kid` (bounds refetch amplification). */
  readonly jwksCooldownMs?: number;
  /** How long a fetched key set is trusted before a refetch. */
  readonly jwksCacheMaxAgeMs?: number;
  /** How long a discovered JWKS location is trusted before discovery is repeated. */
  readonly discoveryTtlMs?: number;
  /** How long to wait before retrying discovery after a failure. */
  readonly discoveryRetryMs?: number;
  /** Clock override for the iat sanity check. */
  readonly now?: () => number;
}

/** Fixed, non-revealing messages per token kind. */
export interface FailureMessages {
  readonly invalid: string;
  readonly expired: string;
  readonly unavailable: string;
}
export const ACCESS_TOKEN_MESSAGES: FailureMessages = {
  invalid: 'bearer token is not valid',
  expired: 'bearer token has expired',
  unavailable: 'token verification is temporarily unavailable',
};
export const ID_TOKEN_MESSAGES: FailureMessages = {
  invalid: 'identity token is not valid',
  expired: 'identity token has expired',
  unavailable: 'sign-in verification is temporarily unavailable',
};

export function unavailableError(messages: FailureMessages = ACCESS_TOKEN_MESSAGES): AuthError {
  return new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, messages.unavailable);
}

export function classifyJoseError(cause: unknown, messages: FailureMessages): AuthError {
  if (cause instanceof AuthError) return cause;
  if (cause instanceof joseErrors.JWTExpired) return new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, messages.expired);
  if (cause instanceof joseErrors.JWKSTimeout) return unavailableError(messages);
  // Everything below is a verdict about the token itself.
  if (
    cause instanceof joseErrors.JWKSNoMatchingKey ||
    cause instanceof joseErrors.JWKSMultipleMatchingKeys ||
    cause instanceof joseErrors.JWSSignatureVerificationFailed ||
    cause instanceof joseErrors.JWSInvalid ||
    cause instanceof joseErrors.JWTInvalid ||
    cause instanceof joseErrors.JWTClaimValidationFailed ||
    cause instanceof joseErrors.JOSEAlgNotAllowed ||
    cause instanceof joseErrors.JOSENotSupported
  ) {
    return new AuthError(ErrorCode.AUTH_TOKEN_INVALID, messages.invalid);
  }
  // Everything else is a problem with obtaining or reading the provider's key set: a network
  // error, a non-200 or redirect, bad JSON, a malformed JWKS (JWKSInvalid) or a malformed key
  // (JWKInvalid). That is the provider's fault, not proof the credential is bad.
  return unavailableError(messages);
}

/** Read at most `limit` bytes of a response body, aborting the transfer as soon as it is exceeded (a declared length is not trusted). */
export async function readBounded(res: Response, limit: number): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('discovery: response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface KeyResolverSource {
  /** The only issuer whose discovery document is accepted, compared exactly. */
  readonly issuer: string;
  /**
   * Where discovery is fetched. Defaults to `{issuer}/.well-known/openid-configuration`. Google's issuer
   * value is `https://accounts.google.com`, which serves discovery at exactly that default.
   */
  readonly discoveryUrl?: string;
  /** Explicit key-set URL; skips discovery. */
  readonly jwksUri?: string;
  /** Variable name used in error messages for `jwksUri`. */
  readonly jwksUriName?: string;
  /** Messages for provider faults. */
  readonly messages?: FailureMessages;
}

export interface KeyResolver {
  getKeys(): Promise<JWTVerifyGetKey>;
}

export function createKeyResolver(source: KeyResolverSource, tuning: VerifierTuning = {}): KeyResolver {
  const httpTimeoutMs = tuning.httpTimeoutMs ?? 5000;
  const now = tuning.now ?? ((): number => Date.now());
  const discoveryRetryMs = tuning.discoveryRetryMs ?? 5000;
  const messages = source.messages ?? ACCESS_TOKEN_MESSAGES;

  let keys: JWTVerifyGetKey | undefined;
  let keysFetchedAt = 0;
  let inflight: Promise<JWTVerifyGetKey> | undefined;
  let lastFailureAt: number | undefined;

  async function discoverJwksUri(): Promise<URL> {
    if (source.jwksUri !== undefined) return assertTrustedUrl(source.jwksUriName ?? 'jwks uri', source.jwksUri);
    const discoveryUrl = source.discoveryUrl ?? `${source.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(discoveryUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(httpTimeoutMs),
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error('discovery: unexpected status');
    const text = await readBounded(res, MAX_DISCOVERY_BYTES);
    const doc = JSON.parse(text) as { issuer?: unknown; jwks_uri?: unknown };
    // The document must describe exactly the issuer we trust; otherwise a hijacked
    // discovery URL could point us at an attacker's key set.
    if (doc.issuer !== source.issuer) throw new Error('discovery: issuer mismatch');
    if (typeof doc.jwks_uri !== 'string') throw new Error('discovery: no jwks_uri');
    return assertTrustedUrl('jwks_uri', doc.jwks_uri);
  }

  async function getKeys(): Promise<JWTVerifyGetKey> {
    const discoveryTtlMs = tuning.discoveryTtlMs ?? DISCOVERY_TTL_MS;
    if (keys !== undefined && now() - keysFetchedAt < discoveryTtlMs) return keys;
    // Re-discovery is only about WHERE the key set lives. If it fails, the previously validated
    // location keeps being used: the key set itself still expires and refetches on its own policy
    // below, and a failure there is a 503. With no previous location there is nothing to use.
    if (lastFailureAt !== undefined && now() - lastFailureAt < discoveryRetryMs) {
      if (keys !== undefined) return keys;
      throw unavailableError(messages);
    }
    inflight ??= (async () => {
      try {
        const uri = await discoverJwksUri();
        const jwks = createRemoteJWKSet(uri, {
          timeoutDuration: httpTimeoutMs,
          cooldownDuration: tuning.jwksCooldownMs ?? 30_000,
          cacheMaxAge: tuning.jwksCacheMaxAgeMs ?? 10 * 60_000,
        });
        keys = jwks;
        keysFetchedAt = now();
        lastFailureAt = undefined;
        return jwks;
      } catch {
        lastFailureAt = now();
        if (keys !== undefined) return keys;
        throw unavailableError(messages);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return { getKeys };
}

import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { AuthError, ErrorCode } from '@xo/errors';
import type { OidcConfig } from './config.js';
import { assertTrustedUrl } from './config.js';

/**
 * Verifies an OIDC *access token* and returns only the two values XO is
 * allowed to derive identity from: the verified issuer and subject. Nothing
 * else from the token (email, org, groups, roles, scopes, custom claims) is
 * returned, so nothing downstream can accidentally trust it.
 *
 * Failure contract (all thrown as `AuthError`, never with token material):
 *  - AUTH_TOKEN_EXPIRED       exp has passed (signature already verified)
 *  - AUTH_TOKEN_INVALID       everything else about the token: malformed,
 *                             oversized, bad signature, disallowed algorithm,
 *                             wrong issuer/audience, not yet valid, unknown
 *                             key id, wrong token type. One code on purpose:
 *                             an unauthenticated caller learns nothing about
 *                             which check failed.
 *  - AUTH_PROVIDER_UNAVAILABLE signing keys could not be obtained. The
 *                             request is refused (fail closed). The code is
 *                             distinct so clients do not discard a session
 *                             over a provider outage.
 */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

/** Asymmetric algorithms only. No `none`, no HS* (a shared-secret MAC against a public key is the classic confusion attack). */
export const ALLOWED_ALGORITHMS: readonly string[] = ['RS256', 'PS256', 'ES256'];

/** Compact JWS shape: three base64url segments (the signature may be empty, which `alg: none` produces; the verifier then rejects it). */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

const MAX_TOKEN_BYTES = 8192;
const MAX_SUBJECT_LENGTH = 255;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Timing/limits that tests tighten; production uses the defaults. */
export interface VerifierTuning {
  /** Per-request network timeout for discovery and JWKS fetches. */
  readonly httpTimeoutMs?: number;
  /** Minimum gap between JWKS refetches triggered by an unknown `kid` (bounds refetch amplification). */
  readonly jwksCooldownMs?: number;
  /** How long a fetched key set is trusted before a refetch. */
  readonly jwksCacheMaxAgeMs?: number;
  /** How long to wait before retrying discovery after a failure. */
  readonly discoveryRetryMs?: number;
  /** Clock override for the iat sanity check. */
  readonly now?: () => number;
}

function invalid(): AuthError {
  return new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'bearer token is not valid');
}
function unavailable(): AuthError {
  return new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'token verification is temporarily unavailable');
}

function classify(cause: unknown): AuthError {
  if (cause instanceof AuthError) return cause;
  if (cause instanceof joseErrors.JWTExpired) return new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, 'bearer token has expired');
  if (cause instanceof joseErrors.JWKSTimeout) return unavailable();
  // Everything below is a verdict about the token itself.
  if (
    cause instanceof joseErrors.JWKSNoMatchingKey ||
    cause instanceof joseErrors.JWKSMultipleMatchingKeys ||
    cause instanceof joseErrors.JWSSignatureVerificationFailed ||
    cause instanceof joseErrors.JWSInvalid ||
    cause instanceof joseErrors.JWTInvalid ||
    cause instanceof joseErrors.JWTClaimValidationFailed ||
    cause instanceof joseErrors.JOSEAlgNotAllowed ||
    cause instanceof joseErrors.JOSENotSupported ||
    cause instanceof joseErrors.JWKInvalid ||
    cause instanceof joseErrors.JWKSInvalid
  ) {
    return invalid();
  }
  // A generic JOSE error or a non-JOSE error while verifying means the key
  // set could not be fetched/parsed (network error, non-200, bad JSON). That
  // is the provider's problem, not proof the credential is bad.
  return unavailable();
}

function headerOf(token: string): { alg?: unknown; typ?: unknown } {
  try {
    return decodeProtectedHeader(token);
  } catch {
    throw invalid();
  }
}

/** RFC 9068 access tokens are `at+jwt`; many providers send `JWT` or nothing. Anything else (notably `id_token`-style types) is refused. */
function typAcceptable(typ: unknown): boolean {
  if (typ === undefined) return true;
  if (typeof typ !== 'string') return false;
  const normalized = typ.toLowerCase().replace(/^application\//, '');
  return normalized === 'jwt' || normalized === 'at+jwt';
}

export function createOidcVerifier(config: OidcConfig, tuning: VerifierTuning = {}): AccessTokenVerifier {
  const httpTimeoutMs = tuning.httpTimeoutMs ?? 5000;
  const now = tuning.now ?? ((): number => Date.now());
  const discoveryRetryMs = tuning.discoveryRetryMs ?? 5000;

  let keys: JWTVerifyGetKey | undefined;
  let keysFetchedAt = 0;
  let inflight: Promise<JWTVerifyGetKey> | undefined;
  let lastFailureAt: number | undefined;

  async function discoverJwksUri(): Promise<URL> {
    if (config.jwksUri !== undefined) return assertTrustedUrl('XO_API_OIDC_JWKS_URI', config.jwksUri);
    const discoveryUrl = `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(discoveryUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(httpTimeoutMs),
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error('discovery: unexpected status');
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_DISCOVERY_BYTES) throw new Error('discovery: response too large');
    const text = await res.text();
    if (text.length > MAX_DISCOVERY_BYTES) throw new Error('discovery: response too large');
    const doc = JSON.parse(text) as { issuer?: unknown; jwks_uri?: unknown };
    // The document must describe exactly the issuer we trust; otherwise a hijacked
    // discovery URL could point us at an attacker's key set.
    if (doc.issuer !== config.issuer) throw new Error('discovery: issuer mismatch');
    if (typeof doc.jwks_uri !== 'string') throw new Error('discovery: no jwks_uri');
    return assertTrustedUrl('jwks_uri', doc.jwks_uri);
  }

  async function getKeys(): Promise<JWTVerifyGetKey> {
    if (keys !== undefined && now() - keysFetchedAt < DISCOVERY_TTL_MS) return keys;
    if (lastFailureAt !== undefined && now() - lastFailureAt < discoveryRetryMs) throw unavailable();
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
        throw unavailable();
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      // Cheap, offline rejections first: no network for obviously bad input.
      if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw invalid();
      const header = headerOf(token);
      if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) throw invalid();
      if (!typAcceptable(header.typ)) throw invalid();

      const getKey = await getKeys();
      let payload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: [...ALLOWED_ALGORITHMS],
          clockTolerance: config.clockSkewSeconds,
          requiredClaims: ['exp', 'sub'],
        }));
      } catch (cause) {
        throw classify(cause);
      }

      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) throw invalid();
      // ID-token indicators: an access token never carries a nonce, and some providers mark the use.
      if (payload['nonce'] !== undefined) throw invalid();
      const tokenUse = payload['token_use'];
      if (tokenUse !== undefined && tokenUse !== 'access') throw invalid();
      // A token issued "in the future" (beyond skew) is not trustworthy.
      if (typeof payload.iat === 'number' && payload.iat > now() / 1000 + config.clockSkewSeconds) throw invalid();

      return { issuer: config.issuer, subject };
    },
  };
}

import { decodeProtectedHeader, jwtVerify } from 'jose';
import { AuthError, ErrorCode } from '@xo/errors';
import type { OidcConfig } from './config.js';

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

import { ACCESS_TOKEN_MESSAGES, classifyJoseError, createKeyResolver, type VerifierTuning } from './jwks.js';
export type { VerifierTuning } from './jwks.js';

const MAX_TOKEN_BYTES = 8192;
const MAX_SUBJECT_LENGTH = 255;
function invalid(): AuthError {
  return new AuthError(ErrorCode.AUTH_TOKEN_INVALID, ACCESS_TOKEN_MESSAGES.invalid);
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
  const now = tuning.now ?? ((): number => Date.now());
  const resolver = createKeyResolver(
    { issuer: config.issuer, ...(config.jwksUri !== undefined ? { jwksUri: config.jwksUri, jwksUriName: 'XO_API_OIDC_JWKS_URI' } : {}) },
    tuning,
  );

  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      // Cheap, offline rejections first: no network for obviously bad input.
      if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw invalid();
      const header = headerOf(token);
      if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) throw invalid();
      if (!typAcceptable(header.typ)) throw invalid();

      const getKey = await resolver.getKeys();
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
        throw classifyJoseError(cause, ACCESS_TOKEN_MESSAGES);
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

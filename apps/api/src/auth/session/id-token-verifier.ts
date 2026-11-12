import { timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { AuthError, ErrorCode } from '@xo/errors';
import { ID_TOKEN_MESSAGES, classifyJoseError, createKeyResolver, type VerifierTuning } from '../oidc/jwks.js';
import type { SessionAuthConfig } from './config.js';

/**
 * Verifies an OpenID Connect ID token for the sign-in → XO-session exchange. This is a SEPARATE verifier from
 * the access-token one: it enforces the opposite token-type rules (an ID token must carry the expected nonce
 * and is addressed to the OAuth client; an access token must not carry a nonce), and the two never share an
 * acceptance path. A verified ID token is used exactly once, to establish `(issuer, sub)`, and is then
 * discarded: it is never accepted as an API credential.
 *
 * Checks, in order of cost (offline ones first): size; header `alg` (RS256 only: Google's documented ID-token
 * algorithm); header `typ` (absent or JWT); signature against the configured issuer's keys; `iss` in the
 * configured accepted set; `aud` contains the configured client id (and `azp` equals it when present or when
 * there are several audiences); `exp` and `iat` present and valid within a bounded skew; `sub` present and
 * bounded; `nonce` equal to the server-issued one for THIS sign-in attempt (constant-time compare).
 *
 * Returns only `(canonical issuer, sub)`. `email`, `name`, `hd` and every other claim are ignored, never
 * returned and never logged. Failures are `AuthError`s with fixed messages: AUTH_TOKEN_INVALID,
 * AUTH_TOKEN_EXPIRED, or AUTH_PROVIDER_UNAVAILABLE when the signing keys cannot be obtained (fail closed).
 */
export interface VerifiedLogin {
  /** Canonical issuer (the configured one), regardless of which accepted `iss` spelling the token used. */
  readonly issuer: string;
  readonly subject: string;
}

export interface IdTokenVerifier {
  verify(idToken: string, expectedNonce: string): Promise<VerifiedLogin>;
}

const MAX_TOKEN_BYTES = 8192;
const MAX_SUBJECT_LENGTH = 255;
const ID_TOKEN_ALGORITHMS = ['RS256'];
const SKEW_SECONDS = 30;

function invalid(): AuthError {
  return new AuthError(ErrorCode.AUTH_TOKEN_INVALID, ID_TOKEN_MESSAGES.invalid);
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createIdTokenVerifier(config: SessionAuthConfig, tuning: VerifierTuning = {}): IdTokenVerifier {
  const now = tuning.now ?? ((): number => Date.now());
  const resolver = createKeyResolver(
    {
      issuer: config.issuer,
      messages: ID_TOKEN_MESSAGES,
      ...(config.jwksUri !== undefined ? { jwksUri: config.jwksUri, jwksUriName: 'XO_API_GOOGLE_JWKS_URI' } : {}),
    },
    tuning,
  );

  return {
    async verify(idToken: string, expectedNonce: string): Promise<VerifiedLogin> {
      if (typeof idToken !== 'string' || idToken.length === 0 || Buffer.byteLength(idToken, 'utf8') > MAX_TOKEN_BYTES) throw invalid();
      let header;
      try {
        header = decodeProtectedHeader(idToken);
      } catch {
        throw invalid();
      }
      if (typeof header.alg !== 'string' || !ID_TOKEN_ALGORITHMS.includes(header.alg)) throw invalid();
      if (header.typ !== undefined && (typeof header.typ !== 'string' || header.typ.toLowerCase() !== 'jwt')) throw invalid();

      const getKey = await resolver.getKeys();
      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, getKey, {
          issuer: [...config.acceptedIssuerClaims],
          audience: config.clientId,
          algorithms: ID_TOKEN_ALGORITHMS,
          clockTolerance: SKEW_SECONDS,
          requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        }));
      } catch (cause) {
        throw classifyJoseError(cause, ID_TOKEN_MESSAGES);
      }

      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) throw invalid();
      if (
        typeof payload.nonce !== 'string' ||
        typeof expectedNonce !== 'string' ||
        expectedNonce.length === 0 ||
        !sameString(payload.nonce, expectedNonce)
      )
        throw invalid();
      const multiAudience = Array.isArray(payload.aud) && payload.aud.length > 1;
      const azp = payload['azp'];
      if (azp !== undefined && azp !== config.clientId) throw invalid();
      if (multiAudience && azp === undefined) throw invalid();
      if (typeof payload.iat !== 'number' || payload.iat > now() / 1000 + SKEW_SECONDS) throw invalid();

      return { issuer: config.issuer, subject };
    },
  };
}

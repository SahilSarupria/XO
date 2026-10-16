import { AuthError, ErrorCode } from '@xo/errors';
import type { IdentityBindingStore } from '../oidc/binding-store.interface.js';
import type { IdTokenVerifier } from './id-token-verifier.js';
import { ChallengeCapReached, type FsChallengeStore } from './challenge-store.js';
import type { FsSessionStore, IssuedSession } from './session-store.js';
import type { FsUnboundLog } from './unbound-log.js';
import type { RateLimiter } from './rate-limiter.js';

/**
 * The sign-in → XO-session protocol, independent of HTTP:
 *
 *   createChallenge()  → server-issued, single-use, 5-minute nonce
 *   exchange(...)      → verify the provider ID token (signature, issuer, audience, expiry, THIS challenge's
 *                        nonce), resolve `(issuer, sub)` through the operator-written binding, mint a session
 *   refresh(...)       → rotate the refresh credential
 *   logout(familyId)   → revoke the session family
 *
 * Authorization is not decided here. A session only proves "this verified identity is bound to this XO
 * principal"; what that principal may do is still decided by the API's own permission checks on every
 * request, and the principal itself is re-read from the binding on every request.
 */
export interface SessionLimits {
  readonly challenge: RateLimiter;
  readonly exchange: RateLimiter;
  readonly refresh: RateLimiter;
}

export interface ChallengeResponse {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface SessionResponse {
  readonly accessCredential: string;
  readonly accessExpiresAt: string;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: string;
}

const UNBOUND_MESSAGE = 'this identity is not authorized to use XO';

function rateLimited(): AuthError {
  return new AuthError(ErrorCode.AUTH_RATE_LIMITED, 'too many requests; try again shortly');
}
function challengeInvalid(): AuthError {
  return new AuthError(ErrorCode.AUTH_CHALLENGE_INVALID, 'the sign-in attempt is invalid or has expired; start again');
}

export class SessionAuthService {
  constructor(
    private readonly deps: {
      readonly challenges: FsChallengeStore;
      readonly sessions: FsSessionStore;
      readonly verifier: IdTokenVerifier;
      readonly bindings: IdentityBindingStore;
      readonly unbound: FsUnboundLog;
      readonly limits: SessionLimits;
    },
  ) {}

  async createChallenge(clientKey: string): Promise<ChallengeResponse> {
    if (!this.deps.limits.challenge.allow(clientKey)) throw rateLimited();
    try {
      const c = await this.deps.challenges.create();
      return { challengeId: c.challengeId, nonce: c.nonce, expiresAt: c.expiresAt };
    } catch (cause) {
      if (cause instanceof ChallengeCapReached) throw rateLimited();
      throw cause;
    }
  }

  async exchange(clientKey: string, challengeId: string, idToken: string): Promise<SessionResponse> {
    if (!this.deps.limits.exchange.allow(clientKey)) throw rateLimited();
    // Consume first: a challenge is single-use whether or not the rest succeeds, and concurrent callers cannot both win.
    const challenge = await this.deps.challenges.consume(challengeId);
    if (challenge === undefined) throw challengeInvalid();

    const login = await this.deps.verifier.verify(idToken, challenge.nonce); // throws AuthError

    const found = await this.deps.bindings.find(login.issuer, login.subject);
    if (!found.ok) throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be completed right now; try again shortly');
    if (found.value === undefined || found.value.revokedAt !== undefined) {
      // Verified at the provider but not authorized here. Remember only (issuer, sub) so an operator can bind it.
      await this.deps.unbound.record(login.issuer, login.subject).catch(() => undefined);
      throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);
    }
    return toResponse(await this.deps.sessions.create(login.issuer, login.subject));
  }

  async refresh(clientKey: string, refreshCredential: string): Promise<SessionResponse> {
    if (!this.deps.limits.refresh.allow(clientKey)) throw rateLimited();
    const rotated = await this.deps.sessions.rotate(refreshCredential);
    if (!rotated.ok) {
      throw rotated.reason === 'expired'
        ? new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, 'session has expired; sign in again')
        : new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'refresh credential is not valid');
    }
    // A revoked or removed binding ends the session at refresh too (requests are also checked on every call).
    const found = await this.deps.bindings.find(rotated.session.issuer, rotated.session.subject);
    if (!found.ok) throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be completed right now; try again shortly');
    if (found.value === undefined || found.value.revokedAt !== undefined) {
      await this.deps.sessions.revoke(rotated.session.familyId, 'binding-revoked');
      throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);
    }
    return toResponse(rotated.issued);
  }

  async logout(familyId: string): Promise<void> {
    await this.deps.sessions.revoke(familyId, 'logout');
  }
}

function toResponse(s: IssuedSession): SessionResponse {
  return {
    accessCredential: s.accessCredential,
    accessExpiresAt: s.accessExpiresAt,
    refreshCredential: s.refreshCredential,
    refreshExpiresAt: s.refreshExpiresAt,
  };
}

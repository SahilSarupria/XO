import { createHash } from 'node:crypto';
import { AuthError, ErrorCode, XoError } from '@xo/errors';
import type { IdentityBindingStore } from '../oidc/binding-store.interface.js';
import type { IdTokenVerifier } from './id-token-verifier.js';
import type { CodeExchanger } from './code-exchanger.js';
import { ChallengeCapReached, type FsChallengeStore } from './challenge-store.js';
import type { FsSessionStore, IssuedSession } from './session-store.js';
import type { FsUnboundLog } from './unbound-log.js';
import type { RateLimiter } from './rate-limiter.js';

/**
 * The sign-in → XO-session protocol, independent of HTTP:
 *
 *   createChallenge()  → server-issued, single-use, 5-minute nonce
 *   exchangeWithCode() → redeem a Google authorization code SERVER-SIDE (the OAuth client secret never leaves this
 *                        process), then continue exactly as `exchange` does with the ID token it returns
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

// Shapes Studio produces. The API re-checks them: the redirect URI is untrusted input to a token request.
const CODE_SHAPE = /^[\x21-\x7e]{1,2048}$/;
const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 §4.1
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/;

function invalidArgument(name: string): XoError {
  return new XoError(ErrorCode.INVALID_ARGUMENT, `"${name}" is not valid`);
}

export function assertCodeExchangeInput(code: string, codeVerifier: string, redirectUri: string): void {
  if (!CODE_SHAPE.test(code)) throw invalidArgument('code');
  if (!VERIFIER_SHAPE.test(codeVerifier)) throw invalidArgument('codeVerifier');
  const m = LOOPBACK_REDIRECT.exec(redirectUri);
  const port = m === null ? 0 : Number(m[1]);
  if (m === null || port < 1024 || port > 65535) throw invalidArgument('redirectUri');
}

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
      /** Provision a personal identity (no organisation) on the first sign-in of a verified, never-bound identity. Never re-provisions a revoked binding. */
      readonly selfSignup?: boolean;
      /** Absent unless the operator configured the OAuth client secret. */
      readonly codeExchanger?: CodeExchanger;
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
    return this.complete(idToken, challenge.nonce);
  }

  async exchangeWithCode(
    clientKey: string,
    challengeId: string,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<SessionResponse> {
    const exchanger = this.deps.codeExchanger;
    if (exchanger === undefined) throw new XoError(ErrorCode.UNIMPLEMENTED, 'server-side code exchange is not enabled on this API');
    if (!this.deps.limits.exchange.allow(clientKey)) throw rateLimited();
    assertCodeExchangeInput(code, codeVerifier, redirectUri); // before consuming: a malformed request must not burn a challenge
    const challenge = await this.deps.challenges.consume(challengeId);
    if (challenge === undefined) throw challengeInvalid();
    const idToken = await exchanger.exchange({ code, codeVerifier, redirectUri });
    return this.complete(idToken, challenge.nonce);
  }

  /** Shared tail: verify the ID token against THIS attempt's nonce, resolve the binding, mint the session. */
  private async complete(idToken: string, nonce: string): Promise<SessionResponse> {
    const login = await this.deps.verifier.verify(idToken, nonce); // throws AuthError

    const found = await this.deps.bindings.find(login.issuer, login.subject);
    if (!found.ok) throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be completed right now; try again shortly');
    if (found.value === undefined && this.deps.selfSignup === true) {
      // Self sign-up: the identity is already verified (signature, issuer, audience, nonce). It gets its OWN
      // personal identity, derived from (issuer, sub), and NO organisation: organisations are created or joined
      // later by an explicit act, never implied by signing in.
      const outcome = await this.provision(login.issuer, login.subject);
      if (outcome === 'unavailable')
        throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be completed right now; try again shortly');
      if (outcome === 'revoked') throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);
      return toResponse(await this.deps.sessions.create(login.issuer, login.subject));
    }
    if (found.value === undefined || found.value.revokedAt !== undefined) {
      // Verified at the provider but not authorized here. Remember only (issuer, sub) so an operator can bind it.
      await this.deps.unbound.record(login.issuer, login.subject).catch(() => undefined);
      throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);
    }
    return toResponse(await this.deps.sessions.create(login.issuer, login.subject));
  }

  /**
   * Creates the personal binding (own identity, no organisation) with an atomic create-only-if-absent, so it can never
   * replace an existing record. Outcomes: 'ok' (we created it, or a concurrent first sign-in did and it is active);
   * 'revoked' (a record exists and is revoked: an operator decision, left untouched); 'unavailable' (storage failed,
   * or a record exists but cannot be read or validated: fail closed, never treated as absent).
   */
  private async provision(issuer: string, subject: string): Promise<'ok' | 'revoked' | 'unavailable'> {
    const bindingId = createHash('sha256')
      .update(JSON.stringify([issuer, subject]))
      .digest('hex');
    const made = await this.deps.bindings.createIfAbsent({
      bindingId,
      issuer,
      subject,
      identityId: `usr_${bindingId.slice(0, 24)}`,
      principalKind: 'human',
      createdAt: new Date().toISOString(),
    });
    if (made.ok) return 'ok';
    if (made.error.code !== ErrorCode.ALREADY_EXISTS) return 'unavailable';
    // Something is already there. Use it only if it is a valid ACTIVE record (a concurrent first sign-in won the race).
    const existing = await this.deps.bindings.find(issuer, subject);
    if (!existing.ok || existing.value === undefined) return 'unavailable';
    return existing.value.revokedAt === undefined ? 'ok' : 'revoked';
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

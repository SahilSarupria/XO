import { AuthError, ErrorCode } from '@xo/errors';
import type { IdentityBindingStore } from '../oidc/binding-store.interface.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SessionGate } from './gate.js';
import type { FsSessionStore } from './session-store.js';
import type { SessionResponse } from './service.js';

/**
 * Refresh and logout for deployments where password sign-in is on but Google sign-in is not (so there is no
 * `SessionAuthService`). Same behaviour as `SessionAuthService.refresh` / `logout`, same routes, same errors — it
 * exists only so those two endpoints are available without requiring Google configuration.
 */
export class SessionLifecycle {
  constructor(
    private readonly deps: {
      readonly sessions: FsSessionStore;
      readonly bindings: IdentityBindingStore;
      readonly limiter: RateLimiter;
      readonly gate?: SessionGate;
    },
  ) {}

  async refresh(clientKey: string, refreshCredential: string): Promise<SessionResponse> {
    if (!this.deps.limiter.allow(clientKey)) throw new AuthError(ErrorCode.AUTH_RATE_LIMITED, 'too many requests; try again shortly');
    const rotated = await this.deps.sessions.rotate(refreshCredential);
    if (!rotated.ok) {
      throw rotated.reason === 'expired'
        ? new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, 'session has expired; sign in again')
        : new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'refresh credential is not valid');
    }
    const found = await this.deps.bindings.find(rotated.session.issuer, rotated.session.subject);
    if (!found.ok) throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be completed right now; try again shortly');
    if (found.value === undefined || found.value.revokedAt !== undefined) {
      await this.deps.sessions.revoke(rotated.session.familyId, 'binding-revoked');
      throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, 'this identity is not authorized to use XO');
    }
    if (this.deps.gate !== undefined) await enforceGate(this.deps.gate, this.deps.sessions, rotated.session);
    const i = rotated.issued;
    return {
      accessCredential: i.accessCredential,
      accessExpiresAt: i.accessExpiresAt,
      refreshCredential: i.refreshCredential,
      refreshExpiresAt: i.refreshExpiresAt,
    };
  }

  async logout(familyId: string): Promise<void> {
    await this.deps.sessions.revoke(familyId, 'logout');
  }
}

/** Runs the gate; on 'revoke' ends the family and refuses with the same generic error any invalid session gets. */
export async function enforceGate(gate: SessionGate, sessions: FsSessionStore, session: Parameters<SessionGate>[0]): Promise<void> {
  let result;
  try {
    result = await gate(session);
  } catch {
    result = 'unavailable' as const;
  }
  if (result === 'ok') return;
  if (result === 'revoke') {
    await sessions.revoke(session.familyId, 'credential-changed').catch(() => undefined);
    throw new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'session credential is not valid');
  }
  throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be verified right now; try again shortly');
}

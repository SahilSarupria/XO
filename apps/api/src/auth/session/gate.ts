import type { SessionIdentity } from './session-store.js';

/**
 * An extra, method-specific liveness check run on EVERY request and every refresh, after the binding check. It exists
 * so a session can die for reasons the session store cannot see — for password sessions: the account was disabled or
 * its password changed since the session was created.
 *
 *   'ok'          the session may continue
 *   'revoke'      end the family for good (re-enabling or re-binding later must not revive it)
 *   'unavailable' the check could not be made; fail closed without revoking (a transient store error must not log everyone out)
 */
export type SessionGateResult = 'ok' | 'revoke' | 'unavailable';
export type SessionGate = (session: SessionIdentity) => Promise<SessionGateResult>;

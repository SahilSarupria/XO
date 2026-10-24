import type { SessionGate } from '../session/gate.js';
import type { FsAccountStore } from './account-store.js';

/** The issuer string password sessions and their bindings use. Reserved: Google/OIDC issuers are https URLs, so no token can ever claim this one. */
export const PASSWORD_ISSUER = 'xo:password';

/**
 * Liveness check for password sessions, run on every request and refresh: the account must still exist and be active,
 * and the session's recorded `passwordVersion` must equal the account's current one. A password change, a reset, or
 * disabling the account therefore ends every session of the account the next time it is used — no index of sessions
 * to scan, nothing to forget to revoke. Sessions of other kinds are untouched.
 */
export function createPasswordSessionGate(accounts: FsAccountStore): SessionGate {
  return async (session) => {
    if (session.issuer !== PASSWORD_ISSUER) return 'ok';
    const account = await accounts.get(session.subject);
    if (account === undefined || account.state !== 'active' || account.passwordVersion !== session.credentialEpoch) return 'revoke';
    return 'ok';
  };
}

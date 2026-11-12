import { AuthError, ErrorCode, XoError } from '@xo/errors';
import type { IdentityBinding, IdentityBindingStore } from '../oidc/binding-store.interface.js';
import { computeBindingId } from '../oidc/fs-binding-store.js';
import type { FsSessionStore, IssuedSession } from '../session/session-store.js';
import type { RateLimiter } from '../session/rate-limiter.js';
import type { SessionResponse } from '../session/service.js';
import type { FsAccountStore } from './account-store.js';
import { LoginNameTakenError, type PasswordAccount } from './account-store.js';
import type { FsAttemptStore } from './attempt-store.js';
import type { AuthLog } from './auth-log.js';
import { PASSWORD_ISSUER } from './gate.js';
import type { PasswordHasher } from './hasher.js';
import { PasswordHasherBusyError } from './hasher.js';
import { loginNameProblem, MAX_PASSWORD_BYTES, normalizeLoginName, normalizePassword, passwordProblem } from './password-policy.js';
import type { FsTokenStore } from './token-store.js';
import { type TokenPurpose } from './token-store.js';

/**
 * Password sign-in, independent of HTTP. See docs/studio/PASSWORD_AUTH_DESIGN.md.
 *
 * What a person can do here:  login · redeem a setup/reset token to set a password · change their own password.
 * What only an operator can do (no HTTP route exists for these): create an account, issue a reset token, disable or
 * re-enable an account. There is no self-registration and no self-service "forgot password": recovery means an
 * operator issues a reset token and hands it over out of band, until verified email delivery exists.
 *
 * A password session is an ordinary XO session (`FsSessionStore`) whose subject is the account id and whose issuer is
 * `PASSWORD_ISSUER`; the principal still comes ONLY from an operator-written binding. Every failure to sign in is the
 * same error, and an unknown login name costs the same time as a wrong password.
 */

const INVALID_CREDENTIALS = 'login name or password is not correct';
const INVALID_TOKEN = 'this code is not valid or has expired';
const MAX_LOGIN_NAME_INPUT = 256;
const IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const invalidCredentials = (): AuthError => new AuthError(ErrorCode.AUTH_TOKEN_INVALID, INVALID_CREDENTIALS);
const invalidToken = (): AuthError => new AuthError(ErrorCode.AUTH_TOKEN_INVALID, INVALID_TOKEN);
const throttled = (): AuthError => new AuthError(ErrorCode.AUTH_RATE_LIMITED, 'too many attempts; try again shortly');
const unavailable = (): AuthError =>
  new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in is busy or unavailable right now; try again shortly');

export interface PasswordAuthDeps {
  readonly accounts: FsAccountStore;
  readonly tokens: FsTokenStore;
  readonly attempts: FsAttemptStore;
  readonly hasher: PasswordHasher;
  readonly sessions: FsSessionStore;
  readonly bindings: IdentityBindingStore;
  readonly log: AuthLog;
  /** Per-process, per-address outer limiter (same mechanism as Google sign-in). */
  readonly limiter: RateLimiter;
  readonly now?: () => Date;
}

export interface CreatedAccount {
  readonly accountId: string;
  readonly loginName: string;
  /** Shown once to the operator; only its digest is stored. */
  readonly setupToken: string;
  readonly setupTokenExpiresAt: string;
}

function toResponse(s: IssuedSession): SessionResponse {
  return {
    accessCredential: s.accessCredential,
    accessExpiresAt: s.accessExpiresAt,
    refreshCredential: s.refreshCredential,
    refreshExpiresAt: s.refreshExpiresAt,
  };
}

export class PasswordAuthService {
  constructor(private readonly deps: PasswordAuthDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Runs a hashing operation, turning "hasher saturated" into the same 503 everywhere. */
  private async hashing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof PasswordHasherBusyError) throw unavailable();
      throw cause;
    }
  }

  private async hashes(loginKey: string, source: string): Promise<{ loginHash: string; sourceHash: string }> {
    return { loginHash: await this.deps.attempts.keyed('login', loginKey), sourceHash: await this.deps.attempts.keyed('source', source) };
  }

  // ------------------------------------------------------------------ sign in

  async login(clientKey: string, loginNameInput: unknown, passwordInput: unknown): Promise<SessionResponse> {
    if (!this.deps.limiter.allow(clientKey)) throw throttled();
    if (
      typeof loginNameInput !== 'string' ||
      typeof passwordInput !== 'string' ||
      loginNameInput.length === 0 ||
      passwordInput.length === 0
    ) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"loginName" and "password" are required');
    }
    const loginName = normalizeLoginName(loginNameInput.slice(0, MAX_LOGIN_NAME_INPUT));
    const { loginHash, sourceHash } = await this.hashes(loginName, clientKey);

    const decision = await this.deps.attempts.check(loginName, clientKey);
    if (decision.blocked) {
      await this.deps.log.record({ event: 'auth.password.throttled', result: 'denied', loginHash, sourceHash });
      throw throttled();
    }

    // An over-long password can never be valid; refuse it before it reaches the hasher, as a normal failed attempt.
    const oversized = Buffer.byteLength(passwordInput, 'utf8') > MAX_PASSWORD_BYTES;
    const account = oversized ? undefined : await this.deps.accounts.findByLogin(loginName);

    // Always do one verification's worth of work, whether or not the account exists, so timing does not separate the cases.
    let passwordOk = false;
    if (account?.hash !== undefined) passwordOk = await this.hashing(() => this.deps.hasher.verify(account.hash as string, passwordInput));
    else if (!oversized) await this.hashing(() => this.deps.hasher.verifyAgainstDummy(passwordInput));

    let boundAndActive = false;
    if (account !== undefined) {
      const found = await this.deps.bindings.find(PASSWORD_ISSUER, account.accountId);
      if (!found.ok) throw unavailable(); // cannot decide: fail closed without counting it as the user's failure
      boundAndActive = account.state === 'active' && found.value !== undefined && found.value.revokedAt === undefined;
    }

    if (account === undefined || !passwordOk || !boundAndActive) {
      await this.deps.attempts.recordFailure(loginName, clientKey);
      await this.deps.log.record({
        event: 'auth.password.login_failed',
        result: 'failed',
        ...(account !== undefined ? { accountId: account.accountId } : {}),
        loginHash,
        sourceHash,
      });
      throw invalidCredentials();
    }

    await this.deps.attempts.recordSuccess(loginName, clientKey);
    await this.upgradeHashIfWeak(account, passwordInput);
    const session = await this.deps.sessions.create(PASSWORD_ISSUER, account.accountId, {
      credentialEpoch: account.passwordVersion,
      methods: ['pwd'],
    });
    await this.deps.log.record({
      event: 'auth.password.login_succeeded',
      result: 'succeeded',
      accountId: account.accountId,
      loginHash,
      sourceHash,
    });
    return toResponse(session);
  }

  /** Rehash with current parameters after a successful verification. Best effort: a failure here never fails the sign-in. */
  private async upgradeHashIfWeak(account: PasswordAccount, password: string): Promise<void> {
    if (account.hash === undefined || !this.deps.hasher.needsRehash(account.hash)) return;
    try {
      const upgraded = await this.deps.hasher.hash(password);
      await this.deps.accounts.update(account.accountId, (cur) =>
        cur.hash === account.hash && cur.passwordVersion === account.passwordVersion ? { ...cur, hash: upgraded } : undefined,
      );
    } catch {
      /* keep the old hash; try again next sign-in */
    }
  }

  // ------------------------------------------------------------------ setup / reset token redemption

  /**
   * Sets the password using a single-use token (first password, or an operator-assisted reset). Issues NO session:
   * the person then signs in normally, and every older session of the account is dead because the version moved.
   */
  async redeemToken(clientKey: string, tokenInput: unknown, newPasswordInput: unknown): Promise<void> {
    if (!this.deps.limiter.allow(clientKey)) throw throttled();
    if (typeof tokenInput !== 'string' || typeof newPasswordInput !== 'string' || tokenInput.length === 0 || tokenInput.length > 256) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"token" and "newPassword" are required');
    }
    const sourceHash = await this.deps.attempts.keyed('source', clientKey);
    const decision = await this.deps.attempts.check('token-redemption', clientKey);
    if (decision.blocked) {
      await this.deps.log.record({ event: 'auth.password.throttled', result: 'denied', sourceHash });
      throw throttled();
    }
    const reject = async (): Promise<never> => {
      await this.deps.attempts.recordFailure('token-redemption', clientKey);
      await this.deps.log.record({ event: 'auth.password.token_rejected', result: 'denied', sourceHash });
      throw invalidToken();
    };

    // Validate everything that can be validated BEFORE spending the token's single use.
    const peeked = await this.deps.tokens.peek(tokenInput);
    if (peeked === undefined) return reject();
    const account = await this.deps.accounts.get(peeked.accountId);
    if (account === undefined || account.state !== 'active' || account.passwordVersion !== peeked.passwordVersion) return reject();
    const problem = passwordProblem(newPasswordInput, account.loginName);
    if (problem !== undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, problem);

    const hash = await this.hashing(() => this.deps.hasher.hash(newPasswordInput));
    const redeemed = await this.deps.tokens.redeem(tokenInput); // exactly one concurrent caller gets this
    if (redeemed === undefined || redeemed.accountId !== account.accountId) return reject();
    const updated = await this.deps.accounts.update(account.accountId, (cur) =>
      cur.state === 'active' && cur.passwordVersion === redeemed.passwordVersion
        ? { ...cur, hash, passwordVersion: cur.passwordVersion + 1, passwordChangedAt: this.now().toISOString() }
        : undefined,
    );
    if (updated === undefined) return reject();
    await this.deps.log.record({
      event: 'auth.password.set',
      result: 'succeeded',
      accountId: account.accountId,
      detail: { purpose: redeemed.purpose, passwordVersion: updated.passwordVersion },
    });
  }

  // ------------------------------------------------------------------ change (authenticated)

  /**
   * The caller proves the CURRENT password even though they hold a valid session (a stolen access credential must not be
   * enough to take over the account). Every session of the account — including the caller's — is then dead; the caller
   * gets a fresh one back, so "change password" does not sign them out on the device they are using.
   */
  async changePassword(clientKey: string, familyId: string, currentInput: unknown, newInput: unknown): Promise<SessionResponse> {
    if (!this.deps.limiter.allow(clientKey)) throw throttled();
    if (typeof currentInput !== 'string' || typeof newInput !== 'string' || currentInput.length === 0 || newInput.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"currentPassword" and "newPassword" are required');
    }
    const identity = await this.deps.sessions.describe(familyId);
    if (identity === undefined || identity.issuer !== PASSWORD_ISSUER) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a password can be changed only from a password session');
    }
    const account = await this.deps.accounts.get(identity.subject);
    if (
      account === undefined ||
      account.state !== 'active' ||
      account.hash === undefined ||
      account.passwordVersion !== identity.credentialEpoch
    )
      throw invalidCredentials();

    const decision = await this.deps.attempts.check(account.loginName, clientKey);
    if (decision.blocked) throw throttled();
    if (Buffer.byteLength(currentInput, 'utf8') > MAX_PASSWORD_BYTES) throw invalidCredentials();
    const currentOk = await this.hashing(() => this.deps.hasher.verify(account.hash as string, currentInput));
    if (!currentOk) {
      await this.deps.attempts.recordFailure(account.loginName, clientKey);
      await this.deps.log.record({
        event: 'auth.password.login_failed',
        result: 'failed',
        accountId: account.accountId,
        detail: { during: 'change' },
      });
      throw invalidCredentials();
    }
    await this.deps.attempts.recordSuccess(account.loginName, clientKey);

    const problem = passwordProblem(newInput, account.loginName);
    if (problem !== undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, problem);
    if (normalizePassword(newInput) === normalizePassword(currentInput))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the new password must differ from the current one');

    const hash = await this.hashing(() => this.deps.hasher.hash(newInput));
    const updated = await this.deps.accounts.update(account.accountId, (cur) =>
      cur.state === 'active' && cur.passwordVersion === account.passwordVersion
        ? { ...cur, hash, passwordVersion: cur.passwordVersion + 1, passwordChangedAt: this.now().toISOString() }
        : undefined,
    );
    if (updated === undefined) throw invalidCredentials(); // changed under us; the caller's session is no longer current
    await this.deps.sessions.revoke(familyId, 'password-changed');
    const session = await this.deps.sessions.create(PASSWORD_ISSUER, updated.accountId, {
      credentialEpoch: updated.passwordVersion,
      methods: ['pwd'],
    });
    await this.deps.log.record({
      event: 'auth.password.changed',
      result: 'succeeded',
      accountId: updated.accountId,
      detail: { passwordVersion: updated.passwordVersion },
    });
    return toResponse(session);
  }

  // ------------------------------------------------------------------ operator actions (CLI only; no HTTP route)

  /** Creates an account with NO password, binds it to an existing principal, and returns a single-use setup token. */
  async createAccount(input: {
    readonly loginName: string;
    readonly identityId: string;
    readonly orgId?: string;
    readonly operator: string;
  }): Promise<CreatedAccount> {
    const loginName = normalizeLoginName(input.loginName);
    const problem = loginNameProblem(loginName);
    if (problem !== undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, problem);
    if (!IDENTITY_ID.test(input.identityId))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'identity id must be 1-128 characters: letters, digits and . _ : @ -');
    let account: PasswordAccount;
    try {
      account = await this.deps.accounts.create(loginName, this.now());
    } catch (cause) {
      if (cause instanceof LoginNameTakenError) throw new XoError(ErrorCode.ALREADY_EXISTS, 'that login name is already in use');
      throw cause;
    }
    const binding: IdentityBinding = {
      bindingId: computeBindingId(PASSWORD_ISSUER, account.accountId),
      issuer: PASSWORD_ISSUER,
      subject: account.accountId,
      identityId: input.identityId,
      principalKind: 'human',
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      createdAt: this.now().toISOString(),
    };
    const bound = await this.deps.bindings.create(binding);
    if (!bound.ok) {
      await this.deps.accounts.discard(account);
      throw bound.error;
    }
    const issued = await this.deps.tokens.issue(account.accountId, 'setup', account.passwordVersion, input.operator);
    const { loginHash } = await this.hashes(loginName, 'operator');
    await this.deps.log.record({
      event: 'auth.account.created',
      result: 'succeeded',
      accountId: account.accountId,
      loginHash,
      operator: input.operator,
    });
    await this.deps.log.record({
      event: 'auth.password.setup_token_issued',
      result: 'succeeded',
      accountId: account.accountId,
      operator: input.operator,
      detail: { expiresAt: issued.expiresAt },
    });
    return { accountId: account.accountId, loginName, setupToken: issued.token, setupTokenExpiresAt: issued.expiresAt };
  }

  /** Operator-assisted recovery: issue a reset token (30 minutes). Supersedes any outstanding token. Changes nothing until redeemed. */
  async issueResetToken(
    loginNameInput: string,
    operator: string,
  ): Promise<{ readonly token: string; readonly expiresAt: string; readonly purpose: TokenPurpose }> {
    const account = await this.deps.accounts.findByLogin(normalizeLoginName(loginNameInput));
    if (account === undefined) throw new XoError(ErrorCode.NOT_FOUND, 'no such account');
    if (account.state !== 'active') throw new XoError(ErrorCode.PRECONDITION_FAILED, 'the account is disabled; enable it first');
    const purpose: TokenPurpose = account.hash === undefined ? 'setup' : 'reset';
    const issued = await this.deps.tokens.issue(account.accountId, purpose, account.passwordVersion, operator);
    await this.deps.log.record({
      event: purpose === 'setup' ? 'auth.password.setup_token_issued' : 'auth.password.reset_token_issued',
      result: 'succeeded',
      accountId: account.accountId,
      operator,
      detail: { expiresAt: issued.expiresAt },
    });
    return { token: issued.token, expiresAt: issued.expiresAt, purpose };
  }

  /** Disabling ends every session of the account on its next use; enabling does not revive them. */
  async setAccountState(loginNameInput: string, state: 'active' | 'disabled', operator: string): Promise<PasswordAccount> {
    const account = await this.deps.accounts.findByLogin(normalizeLoginName(loginNameInput));
    if (account === undefined) throw new XoError(ErrorCode.NOT_FOUND, 'no such account');
    const updated = await this.deps.accounts.update(account.accountId, (cur) =>
      cur.state === state
        ? undefined
        : // Enabling bumps the version too, so sessions that survived a disable (never used while disabled) cannot revive.
          { ...cur, state, passwordVersion: cur.passwordVersion + 1 },
    );
    const result = updated ?? account;
    await this.deps.log.record({
      event: state === 'disabled' ? 'auth.account.disabled' : 'auth.account.enabled',
      result: 'succeeded',
      accountId: account.accountId,
      operator,
    });
    return result;
  }
}

import { FsIdentityBindingStore } from '../oidc/fs-binding-store.js';
import type { IdentityBindingStore } from '../oidc/binding-store.interface.js';
import { createRateLimiter, type RateLimiter } from '../session/rate-limiter.js';
import { FsSessionStore } from '../session/session-store.js';
import type { SessionGate } from '../session/gate.js';
import { FsAccountStore } from './account-store.js';
import { FsAttemptStore } from './attempt-store.js';
import { AuthLog } from './auth-log.js';
import type { PasswordAuthConfig } from './config.js';
import { createPasswordSessionGate } from './gate.js';
import { PasswordHasher } from './hasher.js';
import { PasswordAuthService } from './service.js';
import { FsTokenStore } from './token-store.js';

/** Stores and the session gate. Built FIRST because the gate must be handed to the session layer before the session stores exist. */
export interface PasswordStores {
  readonly accounts: FsAccountStore;
  readonly tokens: FsTokenStore;
  readonly attempts: FsAttemptStore;
  readonly log: AuthLog;
  readonly hasher: PasswordHasher;
  readonly gate: SessionGate;
}

export interface PasswordAuthOptions {
  readonly now?: () => number;
  readonly limiter?: RateLimiter;
}

export function createPasswordStores(config: PasswordAuthConfig, options: PasswordAuthOptions = {}): PasswordStores {
  const accounts = new FsAccountStore(config.accountsDir);
  const now = options.now;
  return {
    accounts,
    tokens: new FsTokenStore(config.accountsDir, now),
    attempts: new FsAttemptStore(config.accountsDir, now),
    log: new AuthLog(config.accountsDir, now !== undefined ? () => new Date(now()) : undefined),
    hasher: new PasswordHasher(config.argon2, config.hashConcurrency, config.hashQueueLimit),
    gate: createPasswordSessionGate(accounts),
  };
}

export interface PasswordAuthBundle {
  readonly service: PasswordAuthService;
  readonly stores: PasswordStores;
}

/** Per-process outer limit on sign-in attempts per client address (the persisted throttle in `FsAttemptStore` is the real defence). */
export function defaultPasswordLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({ windowMs: 60_000, max: 10, ...(now !== undefined ? { now } : {}) });
}

export function createPasswordService(
  stores: PasswordStores,
  deps: { readonly sessions: FsSessionStore; readonly bindings: IdentityBindingStore },
  options: PasswordAuthOptions = {},
): PasswordAuthBundle {
  const service = new PasswordAuthService({
    ...stores,
    sessions: deps.sessions,
    bindings: deps.bindings,
    limiter: options.limiter ?? defaultPasswordLimiter(options.now),
    ...(options.now !== undefined ? { now: () => new Date((options.now as () => number)()) } : {}),
  });
  return { service, stores };
}

/** The stores a password-only deployment needs (no Google sign-in configured). */
export function createPasswordOnlySessionStores(config: PasswordAuthConfig): { sessions: FsSessionStore; bindings: IdentityBindingStore } {
  return { sessions: new FsSessionStore(config.sessionsDir), bindings: new FsIdentityBindingStore(config.bindingsDir) };
}

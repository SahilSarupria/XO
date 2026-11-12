import { FsIdentityBindingStore } from '../oidc/fs-binding-store.js';
import type { IdentityBindingStore } from '../oidc/binding-store.interface.js';
import type { VerifierTuning } from '../oidc/jwks.js';
import type { SessionAuthConfig } from './config.js';
import { createIdTokenVerifier, type IdTokenVerifier } from './id-token-verifier.js';
import { createCodeExchanger, type CodeExchanger, type CodeExchangerOptions } from './code-exchanger.js';
import { FsChallengeStore, type ChallengeStoreOptions } from './challenge-store.js';
import { FsSessionStore, type SessionStoreOptions } from './session-store.js';
import { FsUnboundLog } from './unbound-log.js';
import { createRateLimiter } from './rate-limiter.js';
import { SessionAuthService, type SelfSignupEvent, type SessionLimits } from './service.js';
import type { SessionGate } from './gate.js';

/** Everything the server needs for Google sign-in → XO sessions, wired from one config. */
export interface SessionAuthBundle {
  readonly service: SessionAuthService;
  readonly sessions: FsSessionStore;
  readonly bindings: IdentityBindingStore;
  readonly unbound: FsUnboundLog;
}

/** Overrides for tests; production uses the defaults. */
export interface SessionAuthOptions {
  /** Receives self-signup cap events (counts only). Default: a throttled structured warning on stderr, for log-based alerting. */
  readonly onSelfSignupEvent?: (event: SelfSignupEvent) => void;
  readonly now?: () => number;
  readonly verifier?: IdTokenVerifier;
  readonly verifierTuning?: VerifierTuning;
  /** Replaces the Google code exchanger (tests). Otherwise built from the config when a client secret is set. */
  readonly codeExchanger?: CodeExchanger;
  readonly codeExchangerOptions?: CodeExchangerOptions;
  readonly bindings?: IdentityBindingStore;
  readonly challenge?: ChallengeStoreOptions;
  readonly session?: SessionStoreOptions;
  readonly limits?: SessionLimits;
  /** Method-specific session liveness check (password sessions). Applied on refresh here and on every request by the auth middleware. */
  readonly gate?: SessionGate;
}

const MINUTE = 60_000;

/** Per-process limits (see rate-limiter.ts): 20 challenges, 10 exchanges and 30 refreshes per client address per minute. */
export function defaultLimits(): SessionLimits {
  return {
    challenge: createRateLimiter({ windowMs: MINUTE, max: 20 }),
    exchange: createRateLimiter({ windowMs: MINUTE, max: 10 }),
    refresh: createRateLimiter({ windowMs: MINUTE, max: 30 }),
  };
}

/** One structured warning line per kind per minute: enough for a log alert, never a flood, and no identity in it. */
function defaultSignupAlert(): (event: SelfSignupEvent) => void {
  const last = new Map<string, number>();
  return (event) => {
    const t = Date.now();
    if (t - (last.get(event.kind) ?? 0) < 60_000) return;
    last.set(event.kind, t);
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', event: `self_signup_${event.kind}`, last24h: event.last24h, limit: event.limit })}\n`,
    );
  };
}

export function createSessionAuth(config: SessionAuthConfig, options: SessionAuthOptions = {}): SessionAuthBundle {
  const bindings = options.bindings ?? new FsIdentityBindingStore(config.bindingsDir);
  const sessions = new FsSessionStore(config.sessionsDir, options.session);
  const unbound = new FsUnboundLog(config.sessionsDir);
  const codeExchanger = options.codeExchanger ?? createCodeExchanger(config, options.codeExchangerOptions);
  const service = new SessionAuthService({
    challenges: new FsChallengeStore(config.sessionsDir, options.challenge),
    sessions,
    verifier: options.verifier ?? createIdTokenVerifier(config, options.verifierTuning),
    bindings,
    unbound,
    limits: options.limits ?? defaultLimits(),
    selfSignup: config.selfSignup,
    selfSignupMaxPerDay: config.selfSignupMaxPerDay,
    onSelfSignupEvent: options.onSelfSignupEvent ?? defaultSignupAlert(),
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(codeExchanger !== undefined ? { codeExchanger } : {}),
  });
  return { service, sessions, bindings, unbound };
}

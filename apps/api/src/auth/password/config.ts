import { ErrorCode, XoError } from '@xo/errors';
import { DEFAULT_BINDINGS_DIR, DEFAULT_SESSIONS_DIR } from '../session/config.js';

/**
 * Operator configuration for password sign-in. OFF unless `XO_API_PASSWORD_AUTH` is `1` or `true`. Like the Google
 * session config, it refuses partial configuration: a password setting without the switch is an error at startup (it
 * would otherwise be silently ignored, and an operator would believe a limit was in force when it was not).
 *
 * Passwords are hashed with Argon2id (`@node-rs/argon2`). The cost parameters are operator-tunable because the right
 * value depends on the host: measure it so one verification costs roughly 100-250 ms, never go below OWASP's floor
 * (19 MiB, 2 iterations), and expect hashes to be upgraded on the next successful sign-in when these are raised.
 */
export interface PasswordAuthConfig {
  readonly accountsDir: string;
  /**
   * Where password-only deployments keep sessions and bindings. When Google sign-in is ALSO enabled there is one session
   * store and one binding store however a person signs in, so these MUST name the same directories as
   * `XO_API_SESSIONS_DIR` / `XO_API_OIDC_BINDINGS_DIR`; the server refuses to start if they differ.
   */
  readonly sessionsDir: string;
  readonly bindingsDir: string;
  readonly argon2: { readonly memoryKiB: number; readonly timeCost: number; readonly parallelism: number };
  /** Hashes computed at the same time. Memory-hard hashing is a denial-of-service lever, so this is bounded. */
  readonly hashConcurrency: number;
  readonly hashQueueLimit: number;
}

export const OWASP_MIN_MEMORY_KIB = 19_456;
export const OWASP_MIN_TIME_COST = 2;
const DEFAULT_ACCOUNTS_DIR = '.xo-data/accounts';

function bad(name: string, why: string): XoError {
  return new XoError(ErrorCode.CONFIG_INVALID_VALUE, `invalid ${name}: ${why}`);
}
const unset = (v: string | undefined): boolean => v === undefined || v.trim() === '';

function int(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (unset(raw)) return fallback;
  const text = (raw as string).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min || n > max) throw bad(name, `must be a whole number from ${min} to ${max}`);
  return n;
}

export function loadPasswordAuthConfig(env: Readonly<Record<string, string | undefined>> = process.env): PasswordAuthConfig | undefined {
  const on = /^(1|true)$/i.test((env['XO_API_PASSWORD_AUTH'] ?? '').trim());
  const others = [
    'XO_API_ACCOUNTS_DIR',
    'XO_API_PASSWORD_SESSIONS_DIR',
    'XO_API_PASSWORD_BINDINGS_DIR',
    'XO_API_PASSWORD_ARGON2_MEMORY_KIB',
    'XO_API_PASSWORD_ARGON2_TIME_COST',
    'XO_API_PASSWORD_HASH_CONCURRENCY',
    'XO_API_PASSWORD_HASH_QUEUE_LIMIT',
  ] as const;
  if (!on) {
    for (const name of others) if (!unset(env[name])) throw bad(name, 'set without XO_API_PASSWORD_AUTH=1');
    return undefined;
  }
  return {
    accountsDir: unset(env['XO_API_ACCOUNTS_DIR']) ? DEFAULT_ACCOUNTS_DIR : (env['XO_API_ACCOUNTS_DIR'] as string).trim(),
    sessionsDir: unset(env['XO_API_PASSWORD_SESSIONS_DIR']) ? DEFAULT_SESSIONS_DIR : (env['XO_API_PASSWORD_SESSIONS_DIR'] as string).trim(),
    bindingsDir: unset(env['XO_API_PASSWORD_BINDINGS_DIR']) ? DEFAULT_BINDINGS_DIR : (env['XO_API_PASSWORD_BINDINGS_DIR'] as string).trim(),
    argon2: {
      memoryKiB: int(env, 'XO_API_PASSWORD_ARGON2_MEMORY_KIB', 65_536, OWASP_MIN_MEMORY_KIB, 1_048_576),
      timeCost: int(env, 'XO_API_PASSWORD_ARGON2_TIME_COST', 3, OWASP_MIN_TIME_COST, 10),
      parallelism: 1,
    },
    hashConcurrency: int(env, 'XO_API_PASSWORD_HASH_CONCURRENCY', 2, 1, 16),
    hashQueueLimit: int(env, 'XO_API_PASSWORD_HASH_QUEUE_LIMIT', 32, 0, 1024),
  };
}

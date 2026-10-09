import { randomBytes } from 'node:crypto';
import type { Hasher } from '@xo/crypto';
import { Sha256Hasher } from '@xo/crypto';

/**
 * Cheap namespacing so a leaked key is recognizable in logs, scanners,
 * or `git diff`s of an accidentally-committed `.env` — the same
 * convention as Stripe's `sk_live_...` / GitHub's `ghp_...` prefixes.
 * "xoak" = "XO API Key".
 */
const KEY_PREFIX = 'xoak_';

/**
 * Generates a new raw API key: 256 bits of `node:crypto` randomness,
 * base64url-encoded so it's URL- and header-safe with no escaping. This
 * is the only place a raw key is ever constructed — callers (the key
 * issuance script, tests) get the string back exactly once and are
 * responsible for handing it to the caller/operator before it's
 * discarded; nothing in this codebase persists it in raw form (see
 * `hashApiKey` below and `fs-api-key-store.ts`).
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Hashes a raw API key for at-rest storage and lookup — same principle
 * as password hashing: store the hash, compare hashes, never persist or
 * log the plaintext key. Deliberately unsalted, unlike a password hash:
 * a salt defends against a precomputed dictionary/rainbow-table attack
 * on low-entropy, human-chosen secrets, which doesn't apply here — this
 * key is 256 bits of `generateApiKey()` randomness, not something a
 * human picked, so there is no dictionary to precompute against.
 */
export function hashApiKey(rawKey: string, hasher: Hasher = new Sha256Hasher()): string {
  return hasher.hash(rawKey);
}

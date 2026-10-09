import type { MemoryEntry, MemoryWriteInput } from './memory-types.js';

/**
 * Resolves a write's expiration into a single ISO timestamp (or
 * `undefined` for "never expires"). `expiresAt` (an absolute timestamp)
 * wins if both are given — `ttlSeconds` is sugar computed relative to
 * `now`, `expiresAt` is the caller stating the exact instant, and an
 * exact instant is more specific than a relative offset.
 */
export function resolveExpiresAt(input: Pick<MemoryWriteInput, 'ttlSeconds' | 'expiresAt'>, now: () => Date): string | undefined {
  if (input.expiresAt !== undefined) return input.expiresAt;
  if (input.ttlSeconds !== undefined) return new Date(now().getTime() + input.ttlSeconds * 1000).toISOString();
  return undefined;
}

/** `true` when `entry` has an `expiresAt` strictly in the past relative to `now`. An entry with no `expiresAt` never expires. */
export function isExpired(entry: Pick<MemoryEntry, 'expiresAt'>, now: () => Date): boolean {
  if (entry.expiresAt === undefined) return false;
  return new Date(entry.expiresAt).getTime() <= now().getTime();
}

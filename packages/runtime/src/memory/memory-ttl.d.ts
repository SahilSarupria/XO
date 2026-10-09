import type { MemoryEntry, MemoryWriteInput } from './memory-types.js';
/**
 * Resolves a write's expiration into a single ISO timestamp (or
 * `undefined` for "never expires"). `expiresAt` (an absolute timestamp)
 * wins if both are given — `ttlSeconds` is sugar computed relative to
 * `now`, `expiresAt` is the caller stating the exact instant, and an
 * exact instant is more specific than a relative offset.
 */
export declare function resolveExpiresAt(input: Pick<MemoryWriteInput, 'ttlSeconds' | 'expiresAt'>, now: () => Date): string | undefined;
/** `true` when `entry` has an `expiresAt` strictly in the past relative to `now`. An entry with no `expiresAt` never expires. */
export declare function isExpired(entry: Pick<MemoryEntry, 'expiresAt'>, now: () => Date): boolean;
//# sourceMappingURL=memory-ttl.d.ts.map
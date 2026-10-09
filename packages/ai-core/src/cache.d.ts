import { type Hasher } from '@xo/crypto';
import type { Clock } from './clock.js';
import type { CapabilityId } from './capability-types.js';
export interface CacheKeyInput {
    readonly capability: CapabilityId;
    readonly promptVersion: string;
    readonly input: unknown;
    readonly excerptText: string;
}
/**
 * A cache key is a content hash over everything that determines the
 * *semantic* answer: which capability, which prompt version, and the
 * exact input/excerpt. It deliberately excludes which provider/model
 * ultimately served the request — this layer's whole premise is that
 * callers get a semantic capability, not a provider-specific answer, so
 * a cache hit from a prior call served by provider A is valid for a
 * later call that would have routed to provider B. This same key is
 * what makes deterministic replay possible
 * (`providers/deterministic-replay-provider.ts` and the router's own
 * cache share the identical hashing scheme).
 */
export declare function computeCacheKey(input: CacheKeyInput, hasher?: Hasher): string;
export interface CacheEntry<T> {
    readonly value: T;
    readonly storedAtMs: number;
}
export interface CapabilityCache {
    get<T>(key: string): CacheEntry<T> | undefined;
    set<T>(key: string, value: T): void;
}
export interface InMemoryCacheOptions {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    readonly clock?: Clock;
}
/** An in-memory, optionally TTL-bounded, LRU-by-insertion-order cache. Real and useful for a single process's lifetime (e.g. a `xo compile` run re-hitting the same excerpt across capability calls); a multi-process deployment would swap this for a shared backend (Redis, per `docs/TECH_STACK.md`'s storage rationale) behind the same `CapabilityCache` interface. */
export declare class InMemoryCapabilityCache implements CapabilityCache {
    private readonly options;
    private readonly store;
    private readonly clock;
    constructor(options?: InMemoryCacheOptions);
    get<T>(key: string): CacheEntry<T> | undefined;
    set<T>(key: string, value: T): void;
}
//# sourceMappingURL=cache.d.ts.map
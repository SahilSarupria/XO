import { Sha256Hasher } from '@xo/crypto';
import { SystemClock } from './clock.js';
/** Deterministically stringifies a plain JSON-like value with object keys sorted — the same technique `@xo/xoir`'s `hashing.ts#canonicalStringify` uses, reimplemented locally (rather than depending on `@xo/xoir`) since this is the only place in this package that needs it and pulling in a whole additional package dependency for one small utility isn't worth the coupling. */
function canonicalStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalStringify).join(',')}]`;
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
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
export function computeCacheKey(input, hasher = new Sha256Hasher()) {
    return hasher.hash(canonicalStringify(input));
}
/** An in-memory, optionally TTL-bounded, LRU-by-insertion-order cache. Real and useful for a single process's lifetime (e.g. a `xo compile` run re-hitting the same excerpt across capability calls); a multi-process deployment would swap this for a shared backend (Redis, per `docs/TECH_STACK.md`'s storage rationale) behind the same `CapabilityCache` interface. */
export class InMemoryCapabilityCache {
    options;
    store = new Map();
    clock;
    constructor(options = {}) {
        this.options = options;
        this.clock = options.clock ?? new SystemClock();
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (this.options.ttlMs !== undefined && this.clock.now() - entry.storedAtMs > this.options.ttlMs) {
            this.store.delete(key);
            return undefined;
        }
        return entry;
    }
    set(key, value) {
        if (this.options.maxEntries !== undefined && this.store.size >= this.options.maxEntries && !this.store.has(key)) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey !== undefined)
                this.store.delete(oldestKey);
        }
        this.store.set(key, { value, storedAtMs: this.clock.now() });
    }
}
//# sourceMappingURL=cache.js.map
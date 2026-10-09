import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCacheKey, InMemoryCapabilityCache } from '../src/cache.js';
class FakeClock {
    currentMs = 0;
    now() {
        return this.currentMs;
    }
    advance(ms) {
        this.currentMs += ms;
    }
}
test('computeCacheKey is stable across object key ordering', () => {
    const a = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: { b: 1, a: 2 }, excerptText: 'x' });
    const b = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: { a: 2, b: 1 }, excerptText: 'x' });
    assert.equal(a, b);
});
test('computeCacheKey changes when excerptText changes', () => {
    const a = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'x' });
    const b = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'y' });
    assert.notEqual(a, b);
});
test('computeCacheKey changes when promptVersion changes', () => {
    const a = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'x' });
    const b = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v2', input: {}, excerptText: 'x' });
    assert.notEqual(a, b);
});
test('InMemoryCapabilityCache round-trips a value', () => {
    const cache = new InMemoryCapabilityCache();
    cache.set('k1', { foo: 'bar' });
    const entry = cache.get('k1');
    assert.equal(entry?.value.foo, 'bar');
});
test('InMemoryCapabilityCache returns undefined for a missing key', () => {
    const cache = new InMemoryCapabilityCache();
    assert.equal(cache.get('missing'), undefined);
});
test('InMemoryCapabilityCache expires entries past ttlMs', () => {
    const clock = new FakeClock();
    const cache = new InMemoryCapabilityCache({ ttlMs: 1000, clock });
    cache.set('k1', 'v1');
    clock.advance(999);
    assert.notEqual(cache.get('k1'), undefined);
    clock.advance(2);
    assert.equal(cache.get('k1'), undefined);
});
test('InMemoryCapabilityCache evicts the oldest entry once maxEntries is exceeded', () => {
    const cache = new InMemoryCapabilityCache({ maxEntries: 2 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.set('k3', 'v3');
    assert.equal(cache.get('k1'), undefined);
    assert.notEqual(cache.get('k2'), undefined);
    assert.notEqual(cache.get('k3'), undefined);
});
//# sourceMappingURL=cache.test.js.map
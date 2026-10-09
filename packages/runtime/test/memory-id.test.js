import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemoryEntryId, generateMemoryEntryId } from '../src/memory/memory-id.js';
import { executionScope, sessionScope } from '../src/memory/memory-types.js';
test('deriveMemoryEntryId is pure and deterministic: same (scope, key) always derives the same id', () => {
    const scope = executionScope('exec-determinism');
    const a = deriveMemoryEntryId(scope, 'preference.language');
    const b = deriveMemoryEntryId(scope, 'preference.language');
    assert.equal(a, b);
});
test('deriveMemoryEntryId differs across scopes and across keys', () => {
    const scopeA = executionScope('exec-1');
    const scopeB = executionScope('exec-2');
    assert.notEqual(deriveMemoryEntryId(scopeA, 'k'), deriveMemoryEntryId(scopeB, 'k'));
    assert.notEqual(deriveMemoryEntryId(scopeA, 'k1'), deriveMemoryEntryId(scopeA, 'k2'));
    // Different scope *kind*, same scopeId string and key, must still differ.
    assert.notEqual(deriveMemoryEntryId(executionScope('shared'), 'k'), deriveMemoryEntryId(sessionScope('shared'), 'k'));
});
test('generateMemoryEntryId produces a fresh, non-deterministic id on every call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateMemoryEntryId()));
    assert.equal(ids.size, 50, 'every call must produce a distinct id');
});
//# sourceMappingURL=memory-id.test.js.map
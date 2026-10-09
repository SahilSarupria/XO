import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJson, XoirGraph, XoirGraphId } from '@xo/xoir';
import { ErrorCode } from '@xo/errors';
import { compileViaHttp } from '../src/routes/compiler/compile-adapter.js';

/**
 * Tests `compileViaHttp` directly, not through HTTP — this is precisely
 * the file whose isolation the brief cares most about (`compile.ts` is
 * "the one genuinely volatile surface in this task"), so it gets its
 * own unit-level coverage in addition to `compiler-routes.test.ts`'s
 * HTTP-level coverage of the thin route wrapping it.
 */

test('compiles a real, valid, empty XoirGraph end to end', async () => {
  const graph = XoirGraph.create(XoirGraphId('adapter-test-empty'));
  const result = await compileViaHttp({ kind: 'xoir', graph: toJson(graph) });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.valid, true);
    assert.equal(result.value.graph.id, 'adapter-test-empty');
    assert.deepEqual(result.value.graph.nodes, []);
    assert.deepEqual(result.value.graph.edges, []);
  }
});

test('accepts an optional graphId override', async () => {
  const graph = XoirGraph.create(XoirGraphId('original-id'));
  const result = await compileViaHttp({ kind: 'xoir', graph: toJson(graph), graphId: 'overridden-id' });
  assert.equal(result.ok, true);
});

test('rejects a missing "kind"', async () => {
  const result = await compileViaHttp({ graph: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.INVALID_ARGUMENT);
});

test('rejects an unrecognized "kind"', async () => {
  const result = await compileViaHttp({ kind: 'not-a-real-kind', graph: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.INVALID_ARGUMENT);
});

test('returns UNIMPLEMENTED (not a crash) for "knowledge" input — the deliberate scoping decision', async () => {
  const result = await compileViaHttp({ kind: 'knowledge', graph: { anything: 'goes here, deliberately not validated' } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.UNIMPLEMENTED);
});

test('returns UNIMPLEMENTED for "capability" input', async () => {
  const result = await compileViaHttp({ kind: 'capability', graph: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.UNIMPLEMENTED);
});

test('returns UNIMPLEMENTED for "combined" input', async () => {
  const result = await compileViaHttp({ kind: 'combined' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.UNIMPLEMENTED);
});

test('rejects a missing "graph" for kind "xoir"', async () => {
  const result = await compileViaHttp({ kind: 'xoir' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.INVALID_ARGUMENT);
});

test('rejects a "graph" that is not an object', async () => {
  const result = await compileViaHttp({ kind: 'xoir', graph: 'not an object' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.INVALID_ARGUMENT);
});

test('propagates a clean SERIALIZATION_SCHEMA_MISMATCH (not a crash) for an unsupported schemaVersion', async () => {
  const graph = XoirGraph.create(XoirGraphId('bad-version'));
  const asJson = { ...toJson(graph), schemaVersion: 999_999 };
  const result = await compileViaHttp({ kind: 'xoir', graph: asJson });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.SERIALIZATION_SCHEMA_MISMATCH);
});

test('propagates a clean error (not a crash) for a dangling edge referencing a nonexistent node', async () => {
  const graph = XoirGraph.create(XoirGraphId('dangling-edge'));
  const asJson = {
    ...toJson(graph),
    edges: [{ id: 'e1', kind: 'requires', fromId: 'does-not-exist-1', toId: 'does-not-exist-2', hash: 'irrelevant', metadata: { confidence: 1, sourceRefs: [], transformationChain: [] } }],
  };
  const result = await compileViaHttp({ kind: 'xoir', graph: asJson });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.SERIALIZATION_SCHEMA_MISMATCH);
});

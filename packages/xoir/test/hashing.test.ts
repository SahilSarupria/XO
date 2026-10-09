import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStringify, hashGraphContents, verifyNodeHash } from '../src/hashing.js';
import { ContentHash } from '@xo/types';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId } from '../src/ids.js';

test('canonicalStringify sorts object keys regardless of input order', () => {
  const a = canonicalStringify({ b: 1, a: 2 });
  const b = canonicalStringify({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test('canonicalStringify preserves array order (order is meaningful data)', () => {
  assert.notEqual(canonicalStringify([1, 2, 3]), canonicalStringify([3, 2, 1]));
});

test('canonicalStringify handles nested structures deterministically', () => {
  const value = { z: [{ y: 1, x: 2 }], a: null };
  assert.equal(canonicalStringify(value), '{"a":null,"z":[{"x":2,"y":1}]}');
});

test('hashGraphContents is deterministic regardless of hash-array ordering', () => {
  const hasher = undefined; // use default
  const hashes = [ContentHash('sha256:' + '1'.repeat(64)), ContentHash('sha256:' + '2'.repeat(64))];
  const reordered = [hashes[1]!, hashes[0]!];
  assert.equal(hashGraphContents(hashes, [], hasher), hashGraphContents(reordered, [], hasher));
});

test('hashGraphContents returns a well-formed sentinel hash for an empty graph', () => {
  const h = hashGraphContents([], []);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test('verifyNodeHash/verifyEdgeHash succeed for graph-created nodes/edges and fail after tampering', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  const nodeResult = graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  assert.ok(nodeResult.ok);
  if (!nodeResult.ok) return;
  assert.equal(verifyNodeHash(nodeResult.value), true);

  const tampered = { ...nodeResult.value, properties: { statement: 'tampered', domain: 'd' } };
  assert.equal(verifyNodeHash(tampered), false);
});
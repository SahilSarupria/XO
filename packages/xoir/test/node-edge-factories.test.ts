import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node-kinds.js';
import { createEdge } from '../src/edge-kinds.js';
import { XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { hashNode, hashEdge } from '../src/hashing.js';

test('createNode fills in metadata defaults', () => {
  const node = createNode({
    id: XoirNodeId('cap-1'),
    kind: 'capability',
    properties: { name: 'Draft NDA', description: 'Drafts a mutual NDA' },
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(node.version, 1);
  assert.equal(node.metadata.confidence, 1);
  assert.deepEqual(node.metadata.tags, []);
  assert.equal(node.metadata.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(node.metadata.updatedAt, '2026-01-01T00:00:00.000Z');
});

test('createNode honors explicit confidence/tags/sourceRefs', () => {
  const node = createNode({
    id: XoirNodeId('k-1'),
    kind: 'knowledge',
    properties: { statement: 'NDAs typically run 2-5 years', domain: 'contract-law' },
    confidence: 0.8,
    tags: ['nda', 'duration'],
    sourceRefs: [{ documentPath: 'corpus/ndas.md', locator: 'section-3' }],
  });
  assert.equal(node.metadata.confidence, 0.8);
  assert.deepEqual(node.metadata.tags, ['nda', 'duration']);
  assert.equal(node.metadata.sourceRefs[0]?.documentPath, 'corpus/ndas.md');
});

test('createEdge fills in metadata defaults and omits weight when not given', () => {
  const edge = createEdge({
    id: XoirEdgeId('e-1'),
    kind: 'DEPENDS_ON',
    fromId: XoirNodeId('a'),
    toId: XoirNodeId('b'),
  });
  assert.equal(edge.metadata.confidence, 1);
  assert.equal('weight' in edge, false);
});

test('createEdge keeps an explicitly provided weight', () => {
  const edge = createEdge({
    id: XoirEdgeId('e-2'),
    kind: 'SUPPORTS',
    fromId: XoirNodeId('a'),
    toId: XoirNodeId('b'),
    weight: 0.75,
  });
  assert.equal(edge.weight, 0.75);
});

test('hashNode/hashEdge produce stable, well-formed hashes', () => {
  const node = createNode({ id: XoirNodeId('n1'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  const h1 = hashNode(node);
  const h2 = hashNode(node);
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);

  const edge = createEdge({ id: XoirEdgeId('ed1'), kind: 'USES', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  assert.match(hashEdge(edge), /^sha256:[0-9a-f]{64}$/);
});
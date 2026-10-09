import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';

function buildSampleGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('sample'));
  graph.createAndAddNode({ id: XoirNodeId('cap-draft-nda'), kind: 'capability', properties: { name: 'Draft NDA', description: 'Drafts a mutual NDA' } });
  graph.createAndAddNode({ id: XoirNodeId('k-nda-duration'), kind: 'knowledge', properties: { statement: 'NDAs typically run 2-5 years', domain: 'contract-law' } });
  graph.createAndAddNode({ id: XoirNodeId('constraint-jurisdiction'), kind: 'constraint', properties: { rule: 'Must specify governing law', severity: 'blocking' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('cap-draft-nda'), toId: XoirNodeId('k-nda-duration') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('cap-draft-nda'), toId: XoirNodeId('constraint-jurisdiction') });
  return graph;
}

test('addNode rejects a duplicate id', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  const first = graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = graph.addNode(first.value);
  assert.equal(second.ok, false);
});

test('addEdge rejects dangling endpoints', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  const result = graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('missing') });
  assert.equal(result.ok, false);
});

test('getNode/getEdge return NotFoundError-shaped results for missing ids', () => {
  const graph = buildSampleGraph();
  assert.equal(graph.getNode(XoirNodeId('nope')).ok, false);
  assert.equal(graph.getEdge('nope').ok, false);
});

test('neighbors respects direction and edgeKind filters', () => {
  const graph = buildSampleGraph();
  const capId = XoirNodeId('cap-draft-nda');
  const outgoing = graph.neighbors(capId, { direction: 'outgoing' });
  assert.equal(outgoing.length, 2);

  const dependsOnOnly = graph.neighbors(capId, { direction: 'outgoing', edgeKind: 'DEPENDS_ON' });
  assert.equal(dependsOnOnly.length, 1);
  assert.equal(dependsOnOnly[0]?.id, 'k-nda-duration');

  const incoming = graph.neighbors(XoirNodeId('k-nda-duration'), { direction: 'incoming' });
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]?.id, 'cap-draft-nda');
});

test('removeNode cascades to touching edges', () => {
  const graph = buildSampleGraph();
  const removed = graph.removeNode(XoirNodeId('k-nda-duration'));
  assert.ok(removed.ok);
  assert.equal(graph.allEdges().length, 1);
  assert.equal(graph.neighbors(XoirNodeId('cap-draft-nda')).length, 1);
});

test('subgraph extracts an induced subgraph', () => {
  const graph = buildSampleGraph();
  const sub = graph.subgraph([XoirNodeId('cap-draft-nda'), XoirNodeId('k-nda-duration')], XoirGraphId('sub'));
  assert.ok(sub.ok);
  if (!sub.ok) return;
  assert.equal(sub.value.allNodes().length, 2);
  assert.equal(sub.value.allEdges().length, 1); // only the DEPENDS_ON edge; REQUIRES's target isn't in the subset
});

test('topologicalOrder succeeds on a DAG and respects dependency order', () => {
  const graph = buildSampleGraph();
  const order = graph.topologicalOrder();
  assert.ok(order.ok);
  if (!order.ok) return;
  const capIndex = order.value.indexOf(XoirNodeId('cap-draft-nda'));
  const kIndex = order.value.indexOf(XoirNodeId('k-nda-duration'));
  assert.ok(capIndex < kIndex);
});

test('topologicalOrder fails with a cycle-detected error when the graph has a cycle', () => {
  const graph = XoirGraph.create(XoirGraphId('cyclic'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'DEPENDS_ON', fromId: XoirNodeId('b'), toId: XoirNodeId('a') });
  assert.equal(graph.hasCycle(), true);
  const order = graph.topologicalOrder();
  assert.equal(order.ok, false);
});

test('stats reports counts by kind', () => {
  const graph = buildSampleGraph();
  const stats = graph.stats();
  assert.equal(stats.nodeCount, 3);
  assert.equal(stats.edgeCount, 2);
  assert.equal(stats.nodesByKind['capability'], 1);
  assert.equal(stats.edgesByKind['DEPENDS_ON'], 1);
});

test('contentHash is stable and changes when the graph changes', () => {
  const graph = buildSampleGraph();
  const h1 = graph.contentHash();
  const h2 = graph.contentHash();
  assert.equal(h1, h2);

  graph.createAndAddNode({ id: XoirNodeId('extra'), kind: 'knowledge', properties: { statement: 'x', domain: 'y' } });
  assert.notEqual(graph.contentHash(), h1);
});
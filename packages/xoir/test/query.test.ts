import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { byTag, filterEdges, filterNodes, findPath, nodesOfKind, relationshipsOfKind } from '../src/query.js';

function buildGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('q'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'capability', properties: { name: 'A', description: 'd' }, tags: ['core'] });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, tags: ['core', 'nda'] });
  graph.createAndAddNode({ id: XoirNodeId('c'), kind: 'knowledge', properties: { statement: 's2', domain: 'd' }, confidence: 0.3 });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'DEPENDS_ON', fromId: XoirNodeId('b'), toId: XoirNodeId('c') });
  return graph;
}

test('filterNodes filters by kind, tag, and minConfidence', () => {
  const graph = buildGraph();
  assert.equal(nodesOfKind(graph, 'knowledge').length, 2);
  assert.equal(byTag(graph, 'nda').length, 1);
  assert.equal(filterNodes(graph, { minConfidence: 0.5 }).length, 2);
});

test('filterNodes supports a custom predicate', () => {
  const graph = buildGraph();
  const result = filterNodes(graph, { predicate: (n) => n.id.startsWith('a') });
  assert.equal(result.length, 1);
});

test('filterEdges filters by kind and tag', () => {
  const graph = buildGraph();
  assert.equal(filterEdges(graph, { kind: 'DEPENDS_ON' }).length, 2);
  assert.equal(relationshipsOfKind(graph, 'DEPENDS_ON').length, 2);
});

test('findPath finds a multi-hop path along a specific edge kind', () => {
  const graph = buildGraph();
  const path = findPath(graph, XoirNodeId('a'), XoirNodeId('c'), { edgeKind: 'DEPENDS_ON' });
  assert.deepEqual(path, ['a', 'b', 'c']);
});

test('findPath returns an empty array when no path exists', () => {
  const graph = buildGraph();
  graph.createAndAddNode({ id: XoirNodeId('isolated'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  assert.deepEqual(findPath(graph, XoirNodeId('a'), XoirNodeId('isolated')), []);
});

test('findPath respects maxDepth', () => {
  const graph = buildGraph();
  assert.deepEqual(findPath(graph, XoirNodeId('a'), XoirNodeId('c'), { maxDepth: 1 }), []);
});
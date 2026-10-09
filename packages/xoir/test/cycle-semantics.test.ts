import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { validateGraph } from '../src/validation.js';

test('A CONTRADICTS B and B CONTRADICTS A is a legitimate, structurally valid XOIR graph', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'fact', properties: { statement: 'X is compliant', domain: 'tax' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'fact', properties: { statement: 'X is not compliant', domain: 'gdpr' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'CONTRADICTS', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'CONTRADICTS', fromId: XoirNodeId('b'), toId: XoirNodeId('a') });

  assert.equal(graph.hasCycle(), true);
  const report = validateGraph(graph);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.equal(report.issues.some((i) => i.kind === 'cycle_detected'), false);
});

test('topologicalOrder() over the whole graph fails cleanly (XOIR_CYCLE_DETECTED) when the graph is cyclic — it does not silently return a partial order', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'fact', properties: { statement: 'a', domain: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'fact', properties: { statement: 'b', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'CONTRADICTS', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'CONTRADICTS', fromId: XoirNodeId('b'), toId: XoirNodeId('a') });

  const result = graph.topologicalOrder();
  assert.equal(result.ok, false);
});

test('a DAG-compatible projection (topologicalOrder restricted to REQUIRES edges) still orders correctly even when the whole graph has an unrelated cycle on CONTRADICTS edges', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  graph.createAndAddNode({ id: XoirNodeId('cap-a'), kind: 'capability', properties: { name: 'A', description: 'a' } });
  graph.createAndAddNode({ id: XoirNodeId('cap-b'), kind: 'capability', properties: { name: 'B', description: 'b' } });
  graph.createAndAddNode({ id: XoirNodeId('cap-c'), kind: 'capability', properties: { name: 'C', description: 'c' } });

  // Execution-dependency DAG: C requires B requires A.
  graph.createAndAddEdge({ id: XoirEdgeId('req-1'), kind: 'REQUIRES', fromId: XoirNodeId('cap-c'), toId: XoirNodeId('cap-b') });
  graph.createAndAddEdge({ id: XoirEdgeId('req-2'), kind: 'REQUIRES', fromId: XoirNodeId('cap-b'), toId: XoirNodeId('cap-a') });

  // Unrelated semantic cycle on a different edge kind — legitimate per the general-graph cycle policy.
  graph.createAndAddEdge({ id: XoirEdgeId('c1'), kind: 'CONTRADICTS', fromId: XoirNodeId('cap-a'), toId: XoirNodeId('cap-c') });
  graph.createAndAddEdge({ id: XoirEdgeId('c2'), kind: 'CONTRADICTS', fromId: XoirNodeId('cap-c'), toId: XoirNodeId('cap-a') });

  assert.equal(graph.hasCycle(), true); // whole-graph view: cyclic

  const wholeGraphOrder = graph.topologicalOrder();
  assert.equal(wholeGraphOrder.ok, false); // whole-graph total order: fails, as it should

  const dagProjection = graph.topologicalOrder(['REQUIRES']);
  assert.ok(dagProjection.ok, 'REQUIRES-only projection should be a DAG and order successfully');
  if (!dagProjection.ok) return;
  // Matches the convention established by graph.test.ts's "topologicalOrder respects dependency order":
  // for a fromId --EDGE--> toId edge, fromId (the depender) is ordered before toId (its dependency).
  const indexOf = (id: string) => dagProjection.value.indexOf(XoirNodeId(id));
  assert.ok(indexOf('cap-c') < indexOf('cap-b'));
  assert.ok(indexOf('cap-b') < indexOf('cap-a'));

  // validateGraph must not treat the whole-graph cycle as an error.
  assert.equal(validateGraph(graph).valid, true);
});

test('validateGraph never reports cycle_detected — cycle checking is opt-in via topologicalOrder/hasCycle, never a blocking structural invariant', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'fact', properties: { statement: 'a', domain: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'fact', properties: { statement: 'b', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'CO_OCCURS_WITH', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'CO_OCCURS_WITH', fromId: XoirNodeId('b'), toId: XoirNodeId('a') });
  const report = validateGraph(graph);
  assert.equal(report.issues.filter((i) => i.kind === 'cycle_detected').length, 0);
});

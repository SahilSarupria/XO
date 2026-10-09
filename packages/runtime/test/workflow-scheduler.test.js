import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowScheduler } from '../src/workflow/workflow-scheduler.js';
import { createInitialState, edgeKey } from '../src/workflow/workflow-state.js';
import { NodeId } from '../src/workflow/workflow-graph.js';
const now = () => new Date('2026-01-01T00:00:00.000Z');
function graph(overrides = {}) {
    return {
        graphId: 'g1',
        version: '1.0.0',
        startNodeId: NodeId('start'),
        nodes: [
            { id: NodeId('start'), type: 'start' },
            { id: NodeId('a'), type: 'capability' },
            { id: NodeId('b'), type: 'capability' },
            { id: NodeId('end'), type: 'end' },
        ],
        edges: [
            { from: NodeId('start'), to: NodeId('a') },
            { from: NodeId('a'), to: NodeId('b') },
            { from: NodeId('b'), to: NodeId('end') },
        ],
        ...overrides,
    };
}
test('the start node is ready with an empty state', () => {
    const scheduler = new WorkflowScheduler();
    const cursor = scheduler.computeCursor(graph(), createInitialState(now));
    assert.deepEqual(cursor.ready, [NodeId('start')]);
    assert.deepEqual(cursor.toSkip, []);
});
test('a node becomes ready only once its single predecessor completes', () => {
    const scheduler = new WorkflowScheduler();
    const g = graph();
    const state = { ...createInitialState(now), completedNodes: [NodeId('start')], takenEdges: [edgeKey(NodeId('start'), NodeId('a'))] };
    const cursor = scheduler.computeCursor(g, state);
    assert.deepEqual(cursor.ready, [NodeId('a')]);
});
test('an untaken edge from a completed decision node resolves its target to toSkip, not ready', () => {
    const scheduler = new WorkflowScheduler();
    const g = {
        graphId: 'g2',
        version: '1.0.0',
        startNodeId: NodeId('decide'),
        nodes: [
            { id: NodeId('decide'), type: 'decision' },
            { id: NodeId('yes'), type: 'capability' },
            { id: NodeId('no'), type: 'capability' },
        ],
        edges: [
            { from: NodeId('decide'), to: NodeId('yes'), condition: { kind: 'expression', field: 'x', operator: 'truthy' } },
            { from: NodeId('decide'), to: NodeId('no') },
        ],
    };
    // decision completed, only the "yes" edge was taken
    const state = { ...createInitialState(now), completedNodes: [NodeId('decide')], takenEdges: [edgeKey(NodeId('decide'), NodeId('yes'))] };
    const cursor = scheduler.computeCursor(g, state);
    assert.deepEqual(cursor.ready, [NodeId('yes')]);
    assert.deepEqual(cursor.toSkip, [NodeId('no')]);
});
test('an OR-join node becomes ready once ANY incoming predecessor completes, even if others are skipped', () => {
    const scheduler = new WorkflowScheduler();
    const g = {
        graphId: 'g3',
        version: '1.0.0',
        startNodeId: NodeId('decide'),
        nodes: [
            { id: NodeId('decide'), type: 'decision' },
            { id: NodeId('yes'), type: 'capability' },
            { id: NodeId('no'), type: 'capability' },
            { id: NodeId('join'), type: 'capability' },
        ],
        edges: [
            { from: NodeId('decide'), to: NodeId('yes'), condition: { kind: 'expression', field: 'x', operator: 'truthy' } },
            { from: NodeId('decide'), to: NodeId('no') },
            { from: NodeId('yes'), to: NodeId('join') },
            { from: NodeId('no'), to: NodeId('join') },
        ],
    };
    const state = {
        ...createInitialState(now),
        completedNodes: [NodeId('decide'), NodeId('yes')],
        skippedNodes: [NodeId('no')],
        takenEdges: [edgeKey(NodeId('decide'), NodeId('yes')), edgeKey(NodeId('yes'), NodeId('join')), edgeKey(NodeId('no'), NodeId('join'))],
    };
    const cursor = scheduler.computeCursor(g, state);
    assert.deepEqual(cursor.ready, [NodeId('join')]);
});
test('an AND-join (merge) node stays waiting until ALL predecessors are terminal', () => {
    const scheduler = new WorkflowScheduler();
    const g = {
        graphId: 'g4',
        version: '1.0.0',
        startNodeId: NodeId('fork'),
        nodes: [
            { id: NodeId('fork'), type: 'parallel' },
            { id: NodeId('a'), type: 'capability' },
            { id: NodeId('b'), type: 'capability' },
            { id: NodeId('merge'), type: 'merge' },
        ],
        edges: [
            { from: NodeId('fork'), to: NodeId('a') },
            { from: NodeId('fork'), to: NodeId('b') },
            { from: NodeId('a'), to: NodeId('merge') },
            { from: NodeId('b'), to: NodeId('merge') },
        ],
    };
    const onlyOneDone = { ...createInitialState(now), completedNodes: [NodeId('fork'), NodeId('a')], takenEdges: [edgeKey(NodeId('fork'), NodeId('a')), edgeKey(NodeId('fork'), NodeId('b')), edgeKey(NodeId('a'), NodeId('merge'))] };
    const cursor1 = scheduler.computeCursor(g, onlyOneDone);
    assert.deepEqual(cursor1.waiting, [NodeId('merge')]);
    const bothDone = { ...onlyOneDone, completedNodes: [...onlyOneDone.completedNodes, NodeId('b')], takenEdges: [...onlyOneDone.takenEdges, edgeKey(NodeId('b'), NodeId('merge'))] };
    const cursor2 = scheduler.computeCursor(g, bothDone);
    assert.deepEqual(cursor2.ready, [NodeId('merge')]);
});
test('parallel fan-out: both branches are ready simultaneously', () => {
    const scheduler = new WorkflowScheduler();
    const g = {
        graphId: 'g5',
        version: '1.0.0',
        startNodeId: NodeId('fork'),
        nodes: [
            { id: NodeId('fork'), type: 'parallel' },
            { id: NodeId('a'), type: 'capability' },
            { id: NodeId('b'), type: 'capability' },
        ],
        edges: [
            { from: NodeId('fork'), to: NodeId('a') },
            { from: NodeId('fork'), to: NodeId('b') },
        ],
    };
    const state = { ...createInitialState(now), completedNodes: [NodeId('fork')], takenEdges: [edgeKey(NodeId('fork'), NodeId('a')), edgeKey(NodeId('fork'), NodeId('b'))] };
    const cursor = scheduler.computeCursor(g, state);
    assert.deepEqual(cursor.ready, [NodeId('a'), NodeId('b')]);
});
test('ready/toSkip/waiting are always sorted by graph declaration order, independent of Map/Set iteration', () => {
    const scheduler = new WorkflowScheduler();
    // Declare nodes in an order that would sort differently alphabetically
    // than by declaration, to prove declaration order (not lexical/Set
    // order) governs the result.
    const g = {
        graphId: 'g6',
        version: '1.0.0',
        startNodeId: NodeId('start'),
        nodes: [
            { id: NodeId('start'), type: 'parallel' },
            { id: NodeId('zebra'), type: 'capability' },
            { id: NodeId('apple'), type: 'capability' },
            { id: NodeId('mango'), type: 'capability' },
        ],
        edges: [
            { from: NodeId('start'), to: NodeId('zebra') },
            { from: NodeId('start'), to: NodeId('apple') },
            { from: NodeId('start'), to: NodeId('mango') },
        ],
    };
    const state = {
        ...createInitialState(now),
        completedNodes: [NodeId('start')],
        takenEdges: [edgeKey(NodeId('start'), NodeId('zebra')), edgeKey(NodeId('start'), NodeId('apple')), edgeKey(NodeId('start'), NodeId('mango'))],
    };
    const cursor = scheduler.computeCursor(g, state);
    assert.deepEqual(cursor.ready, [NodeId('zebra'), NodeId('apple'), NodeId('mango')]); // declaration order, not alphabetical
});
test('computeCursor is a pure function: repeated calls with the same inputs return equal results', () => {
    const scheduler = new WorkflowScheduler();
    const g = graph();
    const state = createInitialState(now);
    const first = scheduler.computeCursor(g, state);
    const second = scheduler.computeCursor(g, state);
    assert.deepEqual(first, second);
});
test('outgoingEdges returns edges in declared order', () => {
    const scheduler = new WorkflowScheduler();
    const g = graph();
    const edges = scheduler.outgoingEdges(g, NodeId('a'));
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.to, 'b');
});
//# sourceMappingURL=workflow-scheduler.test.js.map
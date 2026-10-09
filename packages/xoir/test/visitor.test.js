import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { traverseGraph } from '../src/visitor.js';
function buildGraph() {
    const graph = XoirGraph.create(XoirGraphId('g'));
    graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
    return graph;
}
test('traverseGraph visits every node and every edge exactly once', () => {
    const graph = buildGraph();
    const visitedNodeIds = [];
    const visitedEdgeIds = [];
    const visitor = {
        visitNode: (node) => {
            visitedNodeIds.push(node.id);
        },
        visitEdge: (edge) => {
            visitedEdgeIds.push(edge.id);
        },
    };
    traverseGraph(graph, visitor);
    assert.equal(visitedNodeIds.length, 2);
    assert.equal(visitedEdgeIds.length, 1);
});
test('traverseGraph returns per-visit results in order', () => {
    const graph = buildGraph();
    const results = traverseGraph(graph, { visitNode: (node) => `node:${node.id}` });
    assert.deepEqual(results, ['node:a', 'node:b']);
});
test('traverseGraph calls onComplete once with all results', () => {
    const graph = buildGraph();
    let completedWith;
    traverseGraph(graph, {
        visitNode: () => 1,
        onComplete: (results) => {
            completedWith = results;
        },
    });
    assert.equal(completedWith?.length, 2);
});
test('traverseGraph with order "topological" visits dependencies before dependents', () => {
    const graph = buildGraph();
    const order = [];
    traverseGraph(graph, { visitNode: (node) => order.push(node.id) }, { order: 'topological' });
    assert.deepEqual(order, ['a', 'b']);
});
test('traverseGraph with a visitor that has no visitNode/visitEdge is a safe no-op', () => {
    const graph = buildGraph();
    const results = traverseGraph(graph, {});
    assert.deepEqual(results, []);
});
//# sourceMappingURL=visitor.test.js.map
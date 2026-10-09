import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOk, isErr } from '@xo/types';
import { InMemoryGraphStore } from '../src/in-memory-graph-store.js';
function makeGraph() {
    const graph = new InMemoryGraphStore();
    graph.addNode({ id: 'doc:nda', type: 'document_type', properties: { name: 'NDA' } });
    graph.addNode({ id: 'clause:confidentiality', type: 'clause_type', properties: { name: 'Confidentiality' } });
    graph.addNode({ id: 'clause:indemnification', type: 'clause_type', properties: { name: 'Indemnification' } });
    return graph;
}
test('addNode + getNode round-trip', () => {
    const graph = makeGraph();
    const result = graph.getNode('doc:nda');
    assert.ok(isOk(result));
    if (isOk(result))
        assert.equal(result.value.type, 'document_type');
});
test('getNode on a missing id returns NotFoundError', () => {
    const graph = makeGraph();
    assert.ok(isErr(graph.getNode('doc:missing')));
});
test('addEdge fails if either endpoint is missing', () => {
    const graph = makeGraph();
    const result = graph.addEdge({ id: 'e1', type: 'contains_clause', fromId: 'doc:nda', toId: 'clause:nonexistent', properties: {} });
    assert.ok(isErr(result));
});
test('neighbors returns connected nodes, optionally filtered by edge type', () => {
    const graph = makeGraph();
    graph.addEdge({ id: 'e1', type: 'contains_clause', fromId: 'doc:nda', toId: 'clause:confidentiality', properties: {} });
    graph.addEdge({ id: 'e2', type: 'may_contain_clause', fromId: 'doc:nda', toId: 'clause:indemnification', properties: {} });
    const all = graph.neighbors('doc:nda');
    assert.equal(all.length, 2);
    const filtered = graph.neighbors('doc:nda', 'contains_clause');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.id, 'clause:confidentiality');
});
test('query filters by node type', () => {
    const graph = makeGraph();
    const clauses = graph.query({ nodeType: 'clause_type' });
    assert.equal(clauses.length, 2);
});
test('nodeCount and edgeCount reflect graph size', () => {
    const graph = makeGraph();
    graph.addEdge({ id: 'e1', type: 'contains_clause', fromId: 'doc:nda', toId: 'clause:confidentiality', properties: {} });
    assert.equal(graph.nodeCount(), 3);
    assert.equal(graph.edgeCount(), 1);
});
//# sourceMappingURL=in-memory-graph-store.test.js.map
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphFilters } from '../src/filter/GraphFilters.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 'service', label: 'Alpha', position: { x: 0, y: 0 }, metadata: { tier: 'gold' } })
        .upsertNode({ id: 'b', type: 'database', label: 'Beta', position: { x: 0, y: 0 }, metadata: { tier: 'silver' } })
        .upsertNode({ id: 'c', type: 'service', label: 'Gamma', position: { x: 0, y: 0 }, groupId: 'g1' })
        .upsertEdge({ id: 'e1', type: 'link', source: 'a', target: 'b' })
        .upsertEdge({ id: 'e2', type: 'admin', source: 'a', target: 'c' });
}
test('filter by node type', () => {
    const filtered = GraphFilters.empty().withNodeTypes(['service']).apply(sample());
    assert.deepEqual(filtered.nodes.map((n) => n.id).sort(), ['a', 'c']);
});
test('filter by edge type', () => {
    const filtered = GraphFilters.empty().withEdgeTypes(['link']).apply(sample());
    assert.deepEqual(filtered.edges.map((e) => e.id), ['e1']);
});
test('filter by label query', () => {
    const filtered = GraphFilters.empty().withLabelQuery('alp').apply(sample());
    assert.deepEqual(filtered.nodes.map((n) => n.id), ['a']);
});
test('filter by metadata predicate', () => {
    const filtered = GraphFilters.empty()
        .withMetadataPredicate((meta) => meta?.tier === 'gold')
        .apply(sample());
    assert.deepEqual(filtered.nodes.map((n) => n.id), ['a']);
});
test('hiding a node also drops its edges', () => {
    const filtered = GraphFilters.empty().withHiddenNodes(['b']).apply(sample());
    assert.ok(!filtered.getNode('b'));
    assert.ok(!filtered.getEdge('e1'), 'edge touching a hidden node must be dropped');
    assert.ok(filtered.getEdge('e2'), 'unrelated edge must survive');
});
test('collapsed groups hide their member nodes', () => {
    const filtered = GraphFilters.empty().withCollapsedGroups(['g1']).apply(sample());
    assert.ok(!filtered.getNode('c'));
    assert.ok(filtered.getNode('a'));
});
test('empty filters pass everything through', () => {
    const filtered = GraphFilters.empty().apply(sample());
    assert.equal(filtered.nodeCount, 3);
    assert.equal(filtered.edgeCount, 2);
});
//# sourceMappingURL=filters.test.js.map
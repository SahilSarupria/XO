import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeKnowledgeGraphs, parseKnowledgeGraphSlice } from '../src/retrieval/knowledge-graph-merge.js';
function slice(packageName, content, componentKind = 'knowledge_graph') {
    return { packageName, packageVersion: '1.0.0', componentKind, content: typeof content === 'string' ? content : JSON.stringify(content), estimatedTokens: 1 };
}
test('parseKnowledgeGraphSlice returns undefined for a non-knowledge_graph slice', () => {
    const result = parseKnowledgeGraphSlice(slice('a', { nodes: [], edges: [] }, 'safety_rules'));
    assert.equal(result, undefined);
});
test('parseKnowledgeGraphSlice returns undefined for malformed JSON, never throws', () => {
    assert.equal(parseKnowledgeGraphSlice(slice('a', 'not json {{{')), undefined);
});
test('parseKnowledgeGraphSlice returns undefined for valid JSON missing nodes/edges', () => {
    assert.equal(parseKnowledgeGraphSlice(slice('a', { foo: 'bar' })), undefined);
});
test('mergeKnowledgeGraphs merges nodes and edges from multiple packages', () => {
    const sliceA = slice('xo_a', { nodes: [{ id: 'n1', label: 'Node 1' }], edges: [{ from: 'n1', to: 'n2' }] });
    const sliceB = slice('xo_b', { nodes: [{ id: 'n2', label: 'Node 2' }], edges: [{ from: 'n2', to: 'n1' }] });
    const merged = mergeKnowledgeGraphs([sliceA, sliceB]);
    assert.equal(merged.sourceCount, 2);
    assert.equal(merged.nodes.length, 2);
    assert.equal(merged.edges.length, 2);
    assert.deepEqual(merged.conflicts, []);
});
test('mergeKnowledgeGraphs deduplicates identical node ids from the same content (first occurrence wins)', () => {
    const sliceA = slice('xo_a', { nodes: [{ id: 'n1', label: 'Node 1' }], edges: [] });
    const sliceB = slice('xo_b', { nodes: [{ id: 'n1', label: 'Node 1' }], edges: [] }); // identical content, same id
    const merged = mergeKnowledgeGraphs([sliceA, sliceB]);
    assert.equal(merged.nodes.length, 1);
    assert.deepEqual(merged.conflicts, []); // identical content is not a conflict
});
test('mergeKnowledgeGraphs records a conflict when two sources declare the same node id with different content', () => {
    const sliceA = slice('xo_a', { nodes: [{ id: 'n1', label: 'Version A' }], edges: [] });
    const sliceB = slice('xo_b', { nodes: [{ id: 'n1', label: 'Version B' }], edges: [] });
    const merged = mergeKnowledgeGraphs([sliceA, sliceB]);
    assert.equal(merged.nodes.length, 1);
    assert.equal(merged.nodes[0]?.label, 'Version A', 'first occurrence wins');
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.conflicts[0]?.nodeId, 'n1');
    assert.deepEqual(merged.conflicts[0]?.sources, ['xo_a@1.0.0', 'xo_b@1.0.0']);
});
test('mergeKnowledgeGraphs deduplicates identical edges by deep equality', () => {
    const sliceA = slice('xo_a', { nodes: [], edges: [{ from: 'n1', to: 'n2', type: 'references' }] });
    const sliceB = slice('xo_b', { nodes: [], edges: [{ from: 'n1', to: 'n2', type: 'references' }] });
    const merged = mergeKnowledgeGraphs([sliceA, sliceB]);
    assert.equal(merged.edges.length, 1);
});
test('mergeKnowledgeGraphs skips malformed knowledge_graph slices without failing the whole merge', () => {
    const good = slice('xo_a', { nodes: [{ id: 'n1' }], edges: [] });
    const bad = slice('xo_b', 'not json');
    const merged = mergeKnowledgeGraphs([good, bad]);
    assert.equal(merged.sourceCount, 1);
    assert.equal(merged.nodes.length, 1);
});
test('mergeKnowledgeGraphs ignores non-knowledge_graph slices entirely', () => {
    const merged = mergeKnowledgeGraphs([slice('xo_a', { rules: [] }, 'safety_rules')]);
    assert.equal(merged.sourceCount, 0);
    assert.deepEqual(merged.nodes, []);
});
test('mergeKnowledgeGraphs on an empty slice list returns an empty, zero-source result', () => {
    const merged = mergeKnowledgeGraphs([]);
    assert.deepEqual(merged, { nodes: [], edges: [], sourceCount: 0, conflicts: [] });
});
test('a node without a string id is skipped rather than guessed at', () => {
    const merged = mergeKnowledgeGraphs([slice('xo_a', { nodes: [{ label: 'no id here' }], edges: [] })]);
    assert.equal(merged.nodes.length, 0);
});
test('mergeKnowledgeGraphs result is frozen (immutable)', () => {
    const merged = mergeKnowledgeGraphs([]);
    assert.ok(Object.isFrozen(merged));
});
//# sourceMappingURL=knowledge-graph-merge.test.js.map
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { mergeGraphs } from '../src/merge.js';
test('mergeGraphs unions disjoint graphs with no conflicts', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const result = mergeGraphs([g1, g2], XoirGraphId('merged'));
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.graph.stats().nodeCount, 2);
    assert.equal(result.value.conflicts.length, 0);
});
test('mergeGraphs treats identical-content duplicate nodes as a non-conflict', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, now: () => '2026-01-01T00:00:00.000Z' });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, now: () => '2026-01-01T00:00:00.000Z' });
    const result = mergeGraphs([g1, g2], XoirGraphId('merged'));
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.graph.stats().nodeCount, 1);
    assert.equal(result.value.conflicts.length, 0);
});
test('mergeGraphs reports and resolves a conflicting duplicate id under prefer_higher_confidence', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'low-confidence version', domain: 'd' }, confidence: 0.2 });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'high-confidence version', domain: 'd' }, confidence: 0.9 });
    const result = mergeGraphs([g1, g2], XoirGraphId('merged'), 'prefer_higher_confidence');
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 1);
    const resolved = result.value.graph.getNode(XoirNodeId('a'));
    assert.ok(resolved.ok);
    if (resolved.ok)
        assert.equal(resolved.value.properties.statement, 'high-confidence version');
});
test('mergeGraphs under error_on_conflict fails on any conflicting node', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'v1', domain: 'd' } });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'v2', domain: 'd' } });
    const result = mergeGraphs([g1, g2], XoirGraphId('merged'), 'error_on_conflict');
    assert.equal(result.ok, false);
});
test('mergeGraphs only carries over edges whose endpoints survived into the merged graph', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    g1.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    g1.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
    const result = mergeGraphs([g1], XoirGraphId('merged'));
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.graph.stats().edgeCount, 1);
});
test('mergeGraphs rejects an empty list of graphs', () => {
    const result = mergeGraphs([], XoirGraphId('merged'));
    assert.equal(result.ok, false);
});
//# sourceMappingURL=merge.test.js.map
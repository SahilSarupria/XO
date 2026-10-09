import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { diffGraphs, formatDiff } from '../src/diff.js';
test('diffGraphs detects an added node', () => {
    const before = XoirGraph.create(XoirGraphId('g'));
    const after = XoirGraph.create(XoirGraphId('g'));
    after.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const diff = diffGraphs(before, after);
    assert.equal(diff.addedNodes.length, 1);
    assert.equal(diff.removedNodes.length, 0);
});
test('diffGraphs detects a removed node', () => {
    const before = XoirGraph.create(XoirGraphId('g'));
    before.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const after = XoirGraph.create(XoirGraphId('g'));
    const diff = diffGraphs(before, after);
    assert.equal(diff.removedNodes.length, 1);
});
test('diffGraphs detects a modified node with property-level changes', () => {
    const before = XoirGraph.create(XoirGraphId('g'));
    before.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'old', domain: 'd' } });
    const after = XoirGraph.create(XoirGraphId('g'));
    after.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 'new', domain: 'd' } });
    const diff = diffGraphs(before, after);
    assert.equal(diff.modifiedNodes.length, 1);
    assert.equal(diff.modifiedNodes[0]?.propertyChanges.length, 1);
    assert.equal(diff.modifiedNodes[0]?.propertyChanges[0]?.path, 'statement');
});
test('diffGraphs reports unchanged nodes as neither added, removed, nor modified', () => {
    const now = () => '2024-01-01T00:00:00.000Z';
    const before = XoirGraph.create(XoirGraphId('g'));
    before.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, now });
    const after = XoirGraph.create(XoirGraphId('g'));
    after.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, now });
    const diff = diffGraphs(before, after);
    assert.equal(diff.addedNodes.length, 0);
    assert.equal(diff.removedNodes.length, 0);
    assert.equal(diff.modifiedNodes.length, 0);
});
test('diffGraphs detects added/removed edges', () => {
    const before = XoirGraph.create(XoirGraphId('g'));
    before.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    before.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const after = XoirGraph.create(XoirGraphId('g'));
    after.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    after.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    after.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
    const diff = diffGraphs(before, after);
    assert.equal(diff.addedEdges.length, 1);
    assert.equal(diff.removedEdges.length, 0);
});
test('formatDiff renders a non-empty human-readable report when there are changes', () => {
    const before = XoirGraph.create(XoirGraphId('g'));
    const after = XoirGraph.create(XoirGraphId('g'));
    after.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
    const report = formatDiff(diffGraphs(before, after));
    assert.match(report, /\+ node a/);
});
test('formatDiff reports "(no differences)" for identical graphs', () => {
    const g1 = XoirGraph.create(XoirGraphId('g'));
    const g2 = XoirGraph.create(XoirGraphId('g'));
    assert.equal(formatDiff(diffGraphs(g1, g2)), '(no differences)');
});
//# sourceMappingURL=diff.test.js.map
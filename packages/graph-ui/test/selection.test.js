import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphSelection } from '../src/selection/GraphSelection.js';
test('selectNode replaces by default, adds with additive', () => {
    const s0 = GraphSelection.empty().selectNode('a');
    assert.deepEqual([...s0.state.nodeIds], ['a']);
    const s1 = s0.selectNode('b');
    assert.deepEqual([...s1.state.nodeIds], ['b']);
    const s2 = s0.selectNode('b', { additive: true });
    assert.deepEqual([...s2.state.nodeIds].sort(), ['a', 'b']);
});
test('toggleNode toggles membership', () => {
    const s0 = GraphSelection.empty().selectNode('a').toggleNode('a');
    assert.equal(s0.hasNode('a'), false);
    const s1 = s0.toggleNode('a');
    assert.equal(s1.hasNode('a'), true);
});
test('selectEdge / hasEdge', () => {
    const s = GraphSelection.empty().selectEdge('e1');
    assert.ok(s.hasEdge('e1'));
    assert.ok(!s.hasNode('e1'));
});
test('fromBox selects nodes intersecting the rect', () => {
    const model = GraphModel.empty()
        .upsertNode({ id: 'inside', type: 't', label: 'I', position: { x: 10, y: 10 }, size: { width: 20, height: 20 } })
        .upsertNode({ id: 'outside', type: 't', label: 'O', position: { x: 1000, y: 1000 }, size: { width: 20, height: 20 } });
    const sel = GraphSelection.fromBox({ x: 0, y: 0, width: 100, height: 100 }, model);
    assert.deepEqual([...sel.state.nodeIds], ['inside']);
});
test('clear empties the selection', () => {
    const sel = GraphSelection.empty().selectNode('a').selectEdge('e1', { additive: true });
    assert.ok(!sel.isEmpty);
    assert.ok(sel.clear().isEmpty);
});
//# sourceMappingURL=selection.test.js.map
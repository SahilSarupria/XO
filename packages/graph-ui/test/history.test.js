import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStack } from '../src/history/HistoryStack.js';
import { createViewportHistory, createSelectionHistory, createNavigationHistory } from '../src/history/types.js';
test('HistoryStack.init starts with empty past/future', () => {
    const h = HistoryStack.init('a');
    assert.equal(h.present, 'a');
    assert.ok(!h.canUndo);
    assert.ok(!h.canRedo);
});
test('push commits a new present and clears redo history', () => {
    const h0 = HistoryStack.init('a').push('b').push('c');
    assert.equal(h0.present, 'c');
    assert.ok(h0.canUndo);
    assert.ok(!h0.canRedo);
});
test('undo/redo traverse the stack immutably', () => {
    const h0 = HistoryStack.init('a').push('b').push('c');
    const h1 = h0.undo();
    assert.equal(h1.present, 'b');
    assert.equal(h0.present, 'c', 'original must be untouched');
    const h2 = h1.undo();
    assert.equal(h2.present, 'a');
    assert.ok(!h2.canUndo);
    const h3 = h2.redo();
    assert.equal(h3.present, 'b');
    const h4 = h3.redo();
    assert.equal(h4.present, 'c');
    assert.ok(!h4.canRedo);
});
test('undo on empty history is a no-op', () => {
    const h = HistoryStack.init('a');
    assert.equal(h.undo(), h);
});
test('redo on empty future is a no-op', () => {
    const h = HistoryStack.init('a').push('b');
    assert.equal(h.redo(), h);
});
test('pushing after an undo discards the old redo branch', () => {
    const h0 = HistoryStack.init('a').push('b').push('c');
    const h1 = h0.undo(); // present = b, future = [c]
    const h2 = h1.push('d');
    assert.equal(h2.present, 'd');
    assert.ok(!h2.canRedo, 'redo branch to c must be discarded');
});
test('push respects the history size limit', () => {
    let h = HistoryStack.init(0);
    for (let i = 1; i <= 10; i++)
        h = h.push(i, 3);
    assert.equal(h.past.length, 3);
    assert.deepEqual([...h.past], [7, 8, 9]);
});
test('reset clears past/future', () => {
    const h = HistoryStack.init('a').push('b').push('c').reset('z');
    assert.equal(h.present, 'z');
    assert.ok(!h.canUndo);
    assert.ok(!h.canRedo);
});
test('createViewportHistory / createSelectionHistory / createNavigationHistory are typed HistoryStacks', () => {
    const vh = createViewportHistory({ x: 0, y: 0, zoom: 1 });
    assert.deepEqual(vh.present, { x: 0, y: 0, zoom: 1 });
    const sh = createSelectionHistory({ nodeIds: new Set(), edgeIds: new Set(), groupIds: new Set() });
    assert.equal(sh.present.nodeIds.size, 0);
    const nh = createNavigationHistory({ viewport: { x: 0, y: 0, zoom: 1 }, targetNodeId: 'a' });
    assert.equal(nh.present.targetNodeId, 'a');
    const nh2 = nh.push({ viewport: { x: 10, y: 10, zoom: 2 }, targetNodeId: 'b' });
    assert.equal(nh2.present.targetNodeId, 'b');
    assert.equal(nh2.undo().present.targetNodeId, 'a');
});
//# sourceMappingURL=history.test.js.map
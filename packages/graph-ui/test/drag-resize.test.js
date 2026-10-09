import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DragStateMachine } from '../src/interaction/DragStateMachine.js';
import { ResizeStateMachine } from '../src/interaction/ResizeStateMachine.js';
test('DragStateMachine begin/move/end transitions immutably', () => {
    const idle = DragStateMachine.idle();
    assert.ok(!idle.isDragging);
    const dragging = idle.begin(['a', 'b'], { x: 0, y: 0 }, 1000);
    assert.ok(dragging.isDragging);
    assert.ok(!idle.isDragging, 'original must be untouched');
    const moved = dragging.move({ x: 30, y: 40 });
    assert.deepEqual(moved.delta, { x: 30, y: 40 });
    const ended = moved.end();
    assert.ok(!ended.isDragging);
});
test('DragStateMachine.move is a no-op when idle', () => {
    const idle = DragStateMachine.idle();
    assert.equal(idle.move({ x: 5, y: 5 }), idle);
});
test('DragStateMachine.cancel returns to idle without committing the move', () => {
    const dragging = DragStateMachine.idle().begin(['a'], { x: 0, y: 0 }, 0).move({ x: 100, y: 100 });
    const cancelled = dragging.cancel();
    assert.ok(!cancelled.isDragging);
});
test('ResizeStateMachine computes resulting size for a corner handle', () => {
    const idle = ResizeStateMachine.idle();
    const resizing = idle.begin('n1', 'se', { width: 100, height: 50 }, { x: 0, y: 0 });
    const moved = resizing.move({ x: 20, y: 10 });
    assert.deepEqual(moved.resultingSize, { width: 120, height: 60 });
});
test('ResizeStateMachine respects single-axis handles (n/s/e/w)', () => {
    const resizing = ResizeStateMachine.idle().begin('n1', 'e', { width: 100, height: 50 }, { x: 0, y: 0 }).move({ x: 30, y: 999 });
    assert.deepEqual(resizing.resultingSize, { width: 130, height: 50 }, 'height must be unaffected by an east handle');
});
test('ResizeStateMachine respects minSize', () => {
    const resizing = ResizeStateMachine.idle()
        .begin('n1', 'e', { width: 100, height: 50 }, { x: 0, y: 0 }, { width: 80, height: 1 })
        .move({ x: -500, y: 0 });
    assert.equal(resizing.resultingSize.width, 80);
});
test('ResizeStateMachine end/cancel return to idle', () => {
    const resizing = ResizeStateMachine.idle().begin('n1', 'se', { width: 10, height: 10 }, { x: 0, y: 0 });
    assert.ok(!resizing.end().isResizing);
    assert.ok(!resizing.cancel().isResizing);
});
//# sourceMappingURL=drag-resize.test.js.map
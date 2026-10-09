import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TouchGestures } from '../src/interaction/TouchGestures.js';
import { HoverManager } from '../src/interaction/HoverManager.js';
import { ClickArbiter } from '../src/interaction/ClickArbiter.js';

test('TouchGestures tracks per-id touch points immutably', () => {
  const t0 = TouchGestures.empty();
  const t1 = t0.touchStart(1, { x: 0, y: 0 });
  assert.equal(t0.activeTouchCount, 0, 'original must be untouched');
  assert.equal(t1.activeTouchCount, 1);
  const t2 = t1.touchMove(1, { x: 10, y: 10 });
  assert.equal(t2.activeTouchCount, 1);
  const t3 = t2.touchEnd(1);
  assert.equal(t3.activeTouchCount, 0);
});

test('TouchGestures.isMultiTouch flips at 2 active touches', () => {
  const t = TouchGestures.empty().touchStart(1, { x: 0, y: 0 }).touchStart(2, { x: 10, y: 0 });
  assert.ok(t.isMultiTouch);
});

test('gestureBetween recognizes a single-finger pan', () => {
  const before = TouchGestures.empty().touchStart(1, { x: 0, y: 0 });
  const after = before.touchMove(1, { x: 20, y: 5 });
  const gesture = TouchGestures.gestureBetween(before, after);
  assert.deepEqual(gesture, { kind: 'pan', delta: { x: 20, y: 5 } });
});

test('gestureBetween recognizes a two-finger pinch (scale > 1 for spreading apart)', () => {
  const before = TouchGestures.empty().touchStart(1, { x: 0, y: 0 }).touchStart(2, { x: 100, y: 0 });
  const after = before.touchMove(1, { x: -50, y: 0 }).touchMove(2, { x: 150, y: 0 });
  const gesture = TouchGestures.gestureBetween(before, after);
  assert.equal(gesture?.kind, 'pinch');
  if (gesture?.kind === 'pinch') assert.ok(gesture.scale > 1);
});

test('gestureBetween returns undefined without enough touches on either side', () => {
  const empty = TouchGestures.empty();
  assert.equal(TouchGestures.gestureBetween(empty, empty), undefined);
});

test('HoverManager tracks a single hover target and clears', () => {
  const h0 = HoverManager.none();
  const h1 = h0.hoverNode('n1', 1000);
  assert.deepEqual(h1.state.kind, 'node');
  assert.equal(h1.state.id, 'n1');
  const h2 = h1.hoverEdge('e1', 2000);
  assert.equal(h2.state.kind, 'edge');
  const h3 = h2.clear();
  assert.equal(h3.state.kind, 'none');
});

test('HoverManager re-hovering the same node is a no-op (same instance)', () => {
  const h = HoverManager.none().hoverNode('n1', 0);
  assert.equal(h.hoverNode('n1', 500), h);
});

test('ClickArbiter resolves a plain click', () => {
  const arbiter = ClickArbiter.create();
  const down = { kind: 'node' as const, id: 'n1', point: { x: 0, y: 0 }, timestampMs: 0 };
  const { result } = arbiter.pointerDown(down).pointerUp({ x: 0, y: 0 }, 50);
  assert.equal(result?.kind, 'click');
});

test('ClickArbiter resolves a double click within the window and distance', () => {
  const arbiter = ClickArbiter.create();
  const down = { kind: 'node' as const, id: 'n1', point: { x: 0, y: 0 }, timestampMs: 0 };
  const first = arbiter.pointerDown(down).pointerUp({ x: 0, y: 0 }, 50);
  const secondDown = { ...down, timestampMs: 100 };
  const second = first.arbiter.pointerDown(secondDown).pointerUp({ x: 1, y: 1 }, 150);
  assert.equal(second.result?.kind, 'doubleClick');
});

test('ClickArbiter treats a click outside the double-click window as two singles', () => {
  const arbiter = ClickArbiter.create({ doubleClickWindowMs: 100 });
  const down = { kind: 'node' as const, id: 'n1', point: { x: 0, y: 0 }, timestampMs: 0 };
  const first = arbiter.pointerDown(down).pointerUp({ x: 0, y: 0 }, 10);
  const secondDown = { ...down, timestampMs: 500 };
  const second = first.arbiter.pointerDown(secondDown).pointerUp({ x: 0, y: 0 }, 510);
  assert.equal(second.result?.kind, 'click');
});

test('ClickArbiter resolves a long press', () => {
  const arbiter = ClickArbiter.create({ longPressThresholdMs: 400 });
  const down = { kind: 'node' as const, id: 'n1', point: { x: 0, y: 0 }, timestampMs: 0 };
  const { result } = arbiter.pointerDown(down).pointerUp({ x: 0, y: 0 }, 500);
  assert.equal(result?.kind, 'longPress');
});

test('ClickArbiter.pointerUp without a matching pointerDown resolves to nothing', () => {
  const arbiter = ClickArbiter.create();
  const { result } = arbiter.pointerUp({ x: 0, y: 0 }, 100);
  assert.equal(result, undefined);
});

test('ClickArbiter.reset clears pending/last click state', () => {
  const arbiter = ClickArbiter.create();
  const down = { kind: 'canvas' as const, point: { x: 0, y: 0 }, timestampMs: 0 };
  const withDown = arbiter.pointerDown(down);
  const reset = withDown.reset();
  const { result } = reset.pointerUp({ x: 0, y: 0 }, 10);
  assert.equal(result, undefined, 'reset should have cleared the pending down');
});

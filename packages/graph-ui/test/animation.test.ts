import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphAnimation } from '../src/animation/GraphAnimation.js';
import { GraphAnimationEngine } from '../src/animation/GraphAnimationEngine.js';
import { lerpNumber, lerpPoint, lerpViewportState } from '../src/animation/lerp.js';
import { Easings } from '../src/animation/easing.js';
import {
  animateNodePosition,
  nodePositionAt,
  animateEdgeFlow,
  edgeFlowPhaseAt,
  animateHighlight,
  highlightIntensityAt,
  stopHighlight,
  animateSelectionEnter,
  selectionIntensityAt,
  animateExecutionActive,
  executionIntensityAt,
  animateViewportTransition,
  viewportStateAt,
  isViewportTransitionComplete,
  computeExecutionPathReveal,
} from '../src/animation/graphAnimations.js';

test('easing functions map [0,1] to [0,1] with expected endpoints', () => {
  for (const fn of Object.values(Easings)) {
    assert.ok(Math.abs(fn(0) - 0) < 1e-9);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9);
  }
});

test('lerp helpers interpolate linearly', () => {
  assert.equal(lerpNumber(0, 10, 0.5), 5);
  assert.deepEqual(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
  assert.deepEqual(lerpViewportState({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 10, zoom: 3 }, 0.5), { x: 5, y: 5, zoom: 2 });
});

test('GraphAnimation.progressAt clamps to [0,1] for a non-looping animation', () => {
  const anim = GraphAnimation.start(0, 1, 1000, 0, 'linear');
  assert.equal(anim.progressAt(-100), 0);
  assert.equal(anim.progressAt(0), 0);
  assert.equal(anim.progressAt(500), 0.5);
  assert.equal(anim.progressAt(1000), 1);
  assert.equal(anim.progressAt(5000), 1, 'clamps past the end');
});

test('GraphAnimation.isComplete reflects non-looping duration', () => {
  const anim = GraphAnimation.start(0, 1, 1000, 0, 'linear');
  assert.ok(!anim.isComplete(500));
  assert.ok(anim.isComplete(1000));
  assert.ok(anim.isComplete(2000));
});

test('a looping animation never completes and wraps progress', () => {
  const anim = GraphAnimation.start(0, 1, 1000, 0, 'linear', true);
  assert.ok(!anim.isComplete(999999));
  assert.equal(anim.progressAt(0), 0);
  assert.equal(anim.progressAt(1500), 0.5);
  assert.equal(anim.progressAt(2000), 0);
});

test('valueAt applies the supplied lerp function to eased progress', () => {
  const anim = GraphAnimation.start(0, 100, 1000, 0, 'linear');
  assert.equal(anim.valueAt(500, lerpNumber), 50);
});

test('GraphAnimationEngine start/get/stop/has are immutable', () => {
  const e0 = GraphAnimationEngine.empty();
  const e1 = e0.start('a', 0, 1, 1000, 0);
  assert.ok(!e0.has('a'), 'original engine must be untouched');
  assert.ok(e1.has('a'));
  const e2 = e1.stop('a');
  assert.ok(!e2.has('a'));
  assert.ok(e1.has('a'), 'e1 must be untouched by stopping on e2 lineage');
});

test('GraphAnimationEngine.prune drops completed non-looping animations', () => {
  const engine = GraphAnimationEngine.empty().start('done', 0, 1, 100, 0).start('loop', 0, 1, 100, 0, 'linear', true);
  const pruned = engine.prune(1000);
  assert.ok(!pruned.has('done'));
  assert.ok(pruned.has('loop'), 'looping animations are never pruned');
});

test('animateNodePosition / nodePositionAt', () => {
  const engine = animateNodePosition(GraphAnimationEngine.empty(), 'n1', { x: 0, y: 0 }, { x: 100, y: 0 }, 1000, 0);
  assert.deepEqual(nodePositionAt(engine, 'n1', 500, { x: -1, y: -1 }), { x: 50, y: 0 });
  assert.deepEqual(nodePositionAt(engine, 'unknown', 500, { x: -1, y: -1 }), { x: -1, y: -1 });
});

test('animateEdgeFlow loops its phase forever', () => {
  const engine = animateEdgeFlow(GraphAnimationEngine.empty(), 'e1', 1000, 0);
  assert.ok(Math.abs(edgeFlowPhaseAt(engine, 'e1', 500) - 0.5) < 1e-9);
  assert.ok(Math.abs(edgeFlowPhaseAt(engine, 'e1', 1500) - 0.5) < 1e-9, 'wraps around');
  assert.equal(edgeFlowPhaseAt(engine, 'no-such-edge', 500), 0);
});

test('highlight pulse triangle-waves between 0 and 1', () => {
  const engine = animateHighlight(GraphAnimationEngine.empty(), 'n1', 1000, 0);
  assert.ok(Math.abs(highlightIntensityAt(engine, 'n1', 0) - 0) < 1e-9);
  assert.ok(Math.abs(highlightIntensityAt(engine, 'n1', 500) - 1) < 1e-9, 'peaks at the midpoint');
  const stopped = stopHighlight(engine, 'n1');
  assert.equal(highlightIntensityAt(stopped, 'n1', 500), 0);
});

test('selection enter animation fades from 0 to 1 and holds', () => {
  const engine = animateSelectionEnter(GraphAnimationEngine.empty(), 'n1', 200, 0);
  assert.ok(selectionIntensityAt(engine, 'n1', 0) < 0.5);
  assert.ok(Math.abs(selectionIntensityAt(engine, 'n1', 500) - 1) < 1e-9);
  assert.equal(selectionIntensityAt(engine, 'unanimated', 0), 1, 'defaults to fully visible when not animating');
});

test('execution active pulse behaves like highlight pulse', () => {
  const engine = animateExecutionActive(GraphAnimationEngine.empty(), 'n1', 1000, 0);
  assert.ok(Math.abs(executionIntensityAt(engine, 'n1', 500) - 1) < 1e-9);
});

test('viewport transition animates between two states and reports completion', () => {
  const from = { x: 0, y: 0, zoom: 1 };
  const to = { x: 100, y: 100, zoom: 2 };
  const engine = animateViewportTransition(GraphAnimationEngine.empty(), from, to, 1000, 0, 'linear');
  assert.deepEqual(viewportStateAt(engine, 500, from), { x: 50, y: 50, zoom: 1.5 });
  assert.ok(!isViewportTransitionComplete(engine, 500));
  assert.ok(isViewportTransitionComplete(engine, 1000));
  assert.ok(isViewportTransitionComplete(GraphAnimationEngine.empty(), 0), 'no transition in flight counts as complete');
});

test('computeExecutionPathReveal reveals nodes one step at a time', () => {
  const path = ['a', 'b', 'c'];
  const r0 = computeExecutionPathReveal(path, 100, 0, 0);
  assert.deepEqual(r0.revealedNodeIds, ['a']);
  assert.equal(r0.currentIndex, 0);
  assert.ok(!r0.isComplete);

  const r1 = computeExecutionPathReveal(path, 100, 0, 150);
  assert.deepEqual(r1.revealedNodeIds, ['a', 'b']);
  assert.equal(r1.currentIndex, 1);
  assert.ok(Math.abs(r1.progressWithinStep - 0.5) < 1e-9);

  const rEnd = computeExecutionPathReveal(path, 100, 0, 10000);
  assert.deepEqual(rEnd.revealedNodeIds, path);
  assert.ok(rEnd.isComplete);
});

test('computeExecutionPathReveal handles an empty path', () => {
  const r = computeExecutionPathReveal([], 100, 0, 500);
  assert.deepEqual(r.revealedNodeIds, []);
  assert.equal(r.currentIndex, -1);
  assert.ok(r.isComplete);
});

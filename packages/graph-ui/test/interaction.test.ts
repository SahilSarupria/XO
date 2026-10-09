import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphInteraction } from '../src/interaction/GraphInteraction.js';

test('on/emit delivers events to subscribers', () => {
  const bus = new GraphInteraction();
  let received: unknown;
  bus.on('nodeClick', (e) => (received = e));
  bus.emit('nodeClick', { nodeId: 'a' });
  assert.deepEqual(received, { nodeId: 'a' });
});

test('off / unsubscribe function stops delivery', () => {
  const bus = new GraphInteraction();
  let count = 0;
  const off = bus.on('nodeHover', () => count++);
  bus.emit('nodeHover', { nodeId: 'a' });
  off();
  bus.emit('nodeHover', { nodeId: 'a' });
  assert.equal(count, 1);
});

test('nodeDragEnabled toggle defaults to false and is settable', () => {
  const bus = new GraphInteraction();
  assert.equal(bus.nodeDragEnabled, false);
  bus.setNodeDragEnabled(true);
  assert.equal(bus.nodeDragEnabled, true);
});

test('findNeighborInDirection finds the nearest aligned node', () => {
  const model = GraphModel.empty()
    .upsertNode({ id: 'center', type: 't', label: 'C', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'right', type: 't', label: 'R', position: { x: 100, y: 5 } })
    .upsertNode({ id: 'farRight', type: 't', label: 'FR', position: { x: 300, y: 5 } })
    .upsertNode({ id: 'below', type: 't', label: 'B', position: { x: 5, y: 100 } });

  const nearestRight = GraphInteraction.findNeighborInDirection('center', 'right', model);
  assert.equal(nearestRight, 'right');

  const nearestDown = GraphInteraction.findNeighborInDirection('center', 'down', model);
  assert.equal(nearestDown, 'below');

  const nearestUp = GraphInteraction.findNeighborInDirection('center', 'up', model);
  assert.equal(nearestUp, undefined);
});

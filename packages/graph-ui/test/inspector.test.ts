import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphInspector } from '../src/inspector/GraphInspector.js';

test('fromNode builds identity properties from id/type/label', () => {
  const data = GraphInspector.fromNode({ id: 'n1', type: 'service', label: 'My Service', position: { x: 0, y: 0 } });
  assert.equal(data.targetKind, 'node');
  assert.equal(data.targetId, 'n1');
  assert.equal(data.title, 'My Service');
  const identity = data.propertyGroups.find((g) => g.id === 'identity')!;
  assert.ok(identity.properties.some((p) => p.key === 'id' && p.value === 'n1'));
  assert.ok(identity.properties.some((p) => p.key === 'type' && p.value === 'service'));
});

test('fromNode adds a metadata property group and metadataEntries when metadata is present', () => {
  const data = GraphInspector.fromNode({
    id: 'n1',
    type: 'service',
    label: 'S',
    position: { x: 0, y: 0 },
    metadata: { owner: 'team-a', replicas: 3, healthy: true },
  });
  const metadataGroup = data.propertyGroups.find((g) => g.id === 'metadata')!;
  assert.ok(metadataGroup);
  const owner = metadataGroup.properties.find((p) => p.key === 'owner')!;
  assert.equal(owner.value, 'team-a');
  assert.equal(owner.kind, 'text');
  const replicas = metadataGroup.properties.find((p) => p.key === 'replicas')!;
  assert.equal(replicas.kind, 'number');
  const healthy = metadataGroup.properties.find((p) => p.key === 'healthy')!;
  assert.equal(healthy.kind, 'boolean');
  assert.equal(data.metadataEntries.length, 3);
});

test('fromNode omits the metadata group when there is no metadata', () => {
  const data = GraphInspector.fromNode({ id: 'n1', type: 't', label: 'L', position: { x: 0, y: 0 } });
  assert.ok(!data.propertyGroups.some((g) => g.id === 'metadata'));
  assert.equal(data.metadataEntries.length, 0);
});

test('fromEdge builds identity from id/type/source/target and titles by label or id', () => {
  const withLabel = GraphInspector.fromEdge({ id: 'e1', type: 'link', source: 'a', target: 'b', label: 'connects' });
  assert.equal(withLabel.title, 'connects');
  const withoutLabel = GraphInspector.fromEdge({ id: 'e2', type: 'link', source: 'a', target: 'b' });
  assert.equal(withoutLabel.title, 'e2');
  assert.ok(withLabel.propertyGroups[0]!.properties.some((p) => p.key === 'source' && p.value === 'a'));
});

test('badges pass through unchanged', () => {
  const badges = [{ id: 'b1', label: 'Critical', tone: 'danger' as const }];
  const data = GraphInspector.fromNode({ id: 'n1', type: 't', label: 'L', position: { x: 0, y: 0 } }, { badges });
  assert.deepEqual(data.badges, badges);
});

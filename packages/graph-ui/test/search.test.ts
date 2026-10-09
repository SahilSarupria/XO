import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphSearch } from '../src/search/GraphSearch.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'n-alpha', type: 't', label: 'Alpha Service', position: { x: 0, y: 0 }, metadata: { owner: 'team-x' } })
    .upsertNode({ id: 'n-beta', type: 't', label: 'Beta Service', position: { x: 0, y: 0 } })
    .upsertEdge({ id: 'e-connects', type: 'link', source: 'n-alpha', target: 'n-beta', label: 'connects to' });
}

test('search by label', () => {
  const result = GraphSearch.run('alpha', sample());
  assert.equal(result.result.matches.length, 1);
  assert.equal(result.result.matches[0]!.id, 'n-alpha');
  assert.equal(result.result.matches[0]!.field, 'label');
});

test('search by id', () => {
  const result = GraphSearch.run('n-beta', sample());
  assert.equal(result.result.matches[0]!.id, 'n-beta');
  assert.equal(result.result.matches[0]!.field, 'id');
});

test('search by metadata', () => {
  const result = GraphSearch.run('team-x', sample());
  assert.equal(result.result.matches[0]!.field, 'metadata');
});

test('search matches edges too', () => {
  const result = GraphSearch.run('connects', sample());
  assert.ok(result.result.matches.some((m) => m.kind === 'edge' && m.id === 'e-connects'));
});

test('next/previous cycle through matches', () => {
  const model = GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'service-1', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'service-2', position: { x: 0, y: 0 } });
  const s0 = GraphSearch.run('service', model);
  assert.equal(s0.result.activeIndex, 0);
  const s1 = s0.next();
  assert.equal(s1.result.activeIndex, 1);
  const s2 = s1.next();
  assert.equal(s2.result.activeIndex, 0, 'wraps around');
  const s3 = s2.previous();
  assert.equal(s3.result.activeIndex, 1, 'wraps backward');
});

test('empty query yields no matches', () => {
  const result = GraphSearch.run('   ', sample());
  assert.equal(result.result.matches.length, 0);
  assert.equal(result.activeMatch, undefined);
});

/** UW-4c — a lower tier ranks before a higher one whatever the scores; without tiers the merge is by score, as before. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, KnowledgePort } from '@xo/intelligence';
import { CompositeKnowledgePort } from '../src/intelligence/composite-knowledge.js';

const port = (name: string, score: number): KnowledgePort => ({
  retrieve: async () => ({ status: 'ok', evidence: [{ id: name, sourceId: name, sourceName: name, excerpt: name, score } as Evidence] }),
});
const q = { principal: { identityId: 'u' } as never, query: 'x', limit: 5 };

test('tiers order evidence before scores do', async () => {
  const tiered = await new CompositeKnowledgePort([
    { name: 'raw', port: port('raw', 0.9) },
    { name: 'approved', port: port('approved', 0.2), tier: -1 },
  ]).retrieve(q);
  assert.ok(tiered.status === 'ok');
  assert.deepEqual(
    tiered.evidence.map((e) => e.id),
    ['approved', 'raw'],
  );
  const flat = await new CompositeKnowledgePort([
    { name: 'raw', port: port('raw', 0.9) },
    { name: 'other', port: port('other', 0.2) },
  ]).retrieve(q);
  assert.ok(flat.status === 'ok');
  assert.deepEqual(
    flat.evidence.map((e) => e.id),
    ['raw', 'other'],
  );
});

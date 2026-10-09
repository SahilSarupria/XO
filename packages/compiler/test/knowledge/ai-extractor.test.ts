import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer } from '@xo/ai-core';
import { ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import { AiKnowledgeExtractor } from '../../src/knowledge/ai-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import type { KnowledgeExtractionOutput } from '@xo/ai-core';

function makeUnit(): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Confidentiality',
    semanticType: 'obligation',
    content: 'The Receiving Party shall protect Confidential Information.',
    provenance: { documentPath: 'doc.pdf', pages: [2], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.75,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

function makeLayer(output: KnowledgeExtractionOutput): AiCapabilityLayer {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(output) }]);
  return new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
}

test('converts ai-core extractKnowledge items into candidate nodes', async () => {
  const output: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'definition', statement: 'Confidential Information means any non-public data.', domain: 'legal', confidence: 0.9 }],
    relationships: [],
  };
  const extractor = new AiKnowledgeExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodes.length, 1);
  assert.equal(result.value.nodes[0]!.semanticType, 'definition');
  assert.equal(result.value.nodes[0]!.label, 'Confidential Information means any non-public data.');
  assert.equal(result.value.nodes[0]!.isUnitPrimary, false);
});

test('maps a "rule" item to a constraint node', async () => {
  const output: KnowledgeExtractionOutput = { items: [{ id: 'i1', type: 'rule', statement: 'Notice must be given in writing.', domain: 'legal', confidence: 0.8 }], relationships: [] };
  const extractor = new AiKnowledgeExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodes[0]!.semanticType, 'constraint');
});

test('converts ai-core relationships into candidate edge refs keyed by item id', async () => {
  const output: KnowledgeExtractionOutput = {
    items: [
      { id: 'i1', type: 'concept', statement: 'Party', domain: 'legal', confidence: 0.7 },
      { id: 'i2', type: 'concept', statement: 'Agreement', domain: 'legal', confidence: 0.7 },
    ],
    relationships: [{ type: 'depends_on', fromItemId: 'i1', toItemId: 'i2' }],
  };
  const extractor = new AiKnowledgeExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.edges.length, 1);
  assert.equal(result.value.edges[0]!.type, 'depends_on');
  assert.equal(result.value.edges[0]!.fromLocalId, 'i1');
  assert.equal(result.value.edges[0]!.toLocalId, 'i2');
});

test('AI-extracted nodes have no character offset range', async () => {
  const output: KnowledgeExtractionOutput = { items: [{ id: 'i1', type: 'fact', statement: 'x', domain: 'legal', confidence: 0.5 }], relationships: [] };
  const extractor = new AiKnowledgeExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodes[0]!.provenance.charOffsetRange, undefined);
});

test('returns an err Result when the AI capability layer fails (no eligible provider)', async () => {
  const emptyLayer = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const extractor = new AiKnowledgeExtractor(emptyLayer);
  const result = await extractor.extract(makeUnit());
  assert.equal(result.ok, false);
});

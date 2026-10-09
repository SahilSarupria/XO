import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { CapabilityExtractionOutput as AiCapabilityExtractionOutput } from '@xo/ai-core';
import { AiCapabilityExtractor } from '../../src/capabilities/ai-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import type { KnowledgeGraph } from '../../src/knowledge/types.js';

function makeUnit(): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Notifications',
    semanticType: 'obligation',
    content: 'The system shall send a confirmation email to Acme Corp.',
    provenance: { documentPath: 'doc.pdf', pages: [4], sectionPath: ['Article 2'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.75,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

const emptyGraph: KnowledgeGraph = { nodes: [], edges: [] };

function makeLayer(output: AiCapabilityExtractionOutput): AiCapabilityLayer {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(output) }]);
  return new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
}

test('converts ai-core extractCapabilities items into candidate capabilities', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Send Confirmation Email', description: 'Sends a confirmation email upon event completion.', evidenceExcerptOffsets: [[0, 10]], confidence: 0.85 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.capabilities.length, 1);
  assert.equal(result.value.capabilities[0]!.name, 'Send Confirmation Email');
});

test('guesses a category from the name/description via the shared verb lexicon', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Send Confirmation', description: 'This capability can send a message to a party.', evidenceExcerptOffsets: [], confidence: 0.8 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.capabilities[0]!.category, 'communication');
});

test('falls back to the "action" category when no lexicon verb matches', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Something Unusual', description: 'A capability with no recognizable verb at all.', evidenceExcerptOffsets: [], confidence: 0.5 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.capabilities[0]!.category, 'action');
});

test('uses the first evidence offset pair for provenance when present', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Send Email', description: 'x', evidenceExcerptOffsets: [[5, 15]], confidence: 0.7 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.capabilities[0]!.provenance.charOffsetRange, [5, 15]);
});

test('leaves charOffsetRange undefined when no evidence offsets are reported', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Send Email', description: 'x', evidenceExcerptOffsets: [], confidence: 0.7 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.capabilities[0]!.provenance.charOffsetRange, undefined);
});

test('produces no edges (ai-core\'s extractCapabilities has no relationship field of its own)', async () => {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'Send Email', description: 'x', evidenceExcerptOffsets: [], confidence: 0.7 }] };
  const extractor = new AiCapabilityExtractor(makeLayer(output));
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.edges, []);
});

test('returns an err Result when the AI capability layer fails', async () => {
  const emptyLayer = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const extractor = new AiCapabilityExtractor(emptyLayer);
  const result = await extractor.extract(makeUnit(), emptyGraph);
  assert.equal(result.ok, false);
});

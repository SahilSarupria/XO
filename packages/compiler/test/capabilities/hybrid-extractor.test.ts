import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { CapabilityExtractionOutput as AiCapabilityExtractionOutput } from '@xo/ai-core';
import { AiCapabilityExtractor } from '../../src/capabilities/ai-extractor.js';
import { HybridCapabilityExtractor } from '../../src/capabilities/hybrid-extractor.js';
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

function makeWorkingAiExtractor(): AiCapabilityExtractor {
  const output: AiCapabilityExtractionOutput = { capabilities: [{ name: 'AI Detected Capability', description: 'x', evidenceExcerptOffsets: [], confidence: 0.9 }] };
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(output) }]);
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  return new AiCapabilityExtractor(layer);
}

function makeFailingAiExtractor(): AiCapabilityExtractor {
  return new AiCapabilityExtractor(new AiCapabilityLayer({ providers: [], policy: { rules: [] } }));
}

test('with no AI extractor, produces only rule-based candidates', async () => {
  const hybrid = new HybridCapabilityExtractor();
  const result = await hybrid.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.capabilities.length > 0);
  assert.ok(!result.value.capabilities.some((c) => c.name === 'AI Detected Capability'));
});

test('with a working AI extractor, unions rule-based and AI candidates', async () => {
  const hybrid = new HybridCapabilityExtractor(makeWorkingAiExtractor());
  const result = await hybrid.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.capabilities.some((c) => c.name === 'AI Detected Capability'));
});

test('falls back to rule-based only when the AI extractor fails, never failing the whole extraction', async () => {
  const hybrid = new HybridCapabilityExtractor(makeFailingAiExtractor());
  const result = await hybrid.extract(makeUnit(), emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.capabilities.length > 0);
});

// --- P0.9A area C: table detection + quarantine ---

test('a table-quarantined unit produces zero capabilities, even with a working AI extractor configured', async () => {
  const hybrid = new HybridCapabilityExtractor(makeWorkingAiExtractor());
  const unit = { ...makeUnit(), content: 'Sr. No Add-On Name Opted Limits', isTableQuarantined: true };
  const result = await hybrid.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.capabilities, []);
  assert.deepEqual(result.value.edges, []);
});

test('a unit with isTableQuarantined absent (the default) is unaffected', async () => {
  const hybrid = new HybridCapabilityExtractor();
  const result = await hybrid.extract(makeUnit(), emptyGraph); // makeUnit() sets no isTableQuarantined field at all
  assert.ok(result.ok);
});

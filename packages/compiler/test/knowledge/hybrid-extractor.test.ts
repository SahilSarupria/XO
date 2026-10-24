import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, InferenceGuard, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { Logger, LogFields } from '@xo/logger';
import type { KnowledgeExtractionOutput } from '@xo/ai-core';
import { AiKnowledgeExtractor } from '../../src/knowledge/ai-extractor.js';
import { HybridKnowledgeExtractor } from '../../src/knowledge/hybrid-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';

function makeUnit(): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Confidentiality',
    semanticType: 'obligation',
    content: 'The Receiving Party shall protect Confidential Information from Acme Corp.',
    provenance: { documentPath: 'doc.pdf', pages: [2], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.75,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

function makeWorkingAiExtractor(): AiKnowledgeExtractor {
  const output: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'concept', statement: 'Confidential Information', domain: 'legal', confidence: 0.85 }],
    relationships: [],
  };
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(output) }]);
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  return new AiKnowledgeExtractor(layer);
}

function makeFailingAiExtractor(): AiKnowledgeExtractor {
  const layer = new AiCapabilityLayer({ providers: [], policy: { rules: [] } }); // no eligible provider -> every call fails
  return new AiKnowledgeExtractor(layer);
}

test('with no AI extractor configured, produces only rule-based candidates', async () => {
  const hybrid = new HybridKnowledgeExtractor();
  const result = await hybrid.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.nodes.some((n) => n.isUnitPrimary)); // rule-based always contributes the primary node
  assert.ok(!result.value.nodes.some((n) => n.localId === 'i1')); // no AI-sourced node
});

test('with a working AI extractor, unions rule-based and AI candidates', async () => {
  const hybrid = new HybridKnowledgeExtractor(makeWorkingAiExtractor(), undefined, { mode: 'always' });
  const result = await hybrid.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.nodes.some((n) => n.isUnitPrimary));
  assert.ok(result.value.nodes.some((n) => n.localId === 'i1'));
});

test('falls back to rule-based only when the AI extractor fails for a unit', async () => {
  const hybrid = new HybridKnowledgeExtractor(makeFailingAiExtractor());
  const result = await hybrid.extract(makeUnit());
  assert.ok(result.ok); // the whole call still succeeds — this is the "AI unavailable, still a correct graph" guarantee
  if (!result.ok) return;
  assert.ok(result.value.nodes.some((n) => n.isUnitPrimary));
  assert.equal(result.value.nodes.length, result.value.nodes.filter((n) => n.sourceUnitId === 'unit-1').length); // every node still traces to the unit
});

// --- P0.9A area C: table detection + quarantine ---

test('a table-quarantined unit produces zero knowledge nodes, even with a working AI extractor configured', async () => {
  const hybrid = new HybridKnowledgeExtractor(makeWorkingAiExtractor());
  const unit = { ...makeUnit(), content: 'Sr. No Add-On Name Opted Limits', isTableQuarantined: true };
  const result = await hybrid.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.nodes, []);
  assert.deepEqual(result.value.edges, []);
});

test('a unit with isTableQuarantined absent (the default) is unaffected — same as false', async () => {
  const hybrid = new HybridKnowledgeExtractor();
  const result = await hybrid.extract(makeUnit()); // makeUnit() sets no isTableQuarantined field at all
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.nodes.some((n) => n.isUnitPrimary));
});

function budgetLayer(maxTotalTokens: number): { layer: AiCapabilityLayer; provider: ScriptableTestProvider } {
  const output: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'concept', statement: 'Confidential Information', domain: 'legal', confidence: 0.85 }],
    relationships: [],
  };
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(output) }]);
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
    inferenceScope: new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens }).beginRun(),
  });
  return { layer, provider };
}

function recordingLogger(records: { message: string; fields: LogFields }[]): Logger {
  const make = (): Logger => ({
    level: 'trace',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message: string, fields?: LogFields) => void records.push({ message, fields: fields ?? {} }),
    error: () => {},
    fatal: () => {},
    child: () => make(),
  });
  return make();
}

test('budget exhaustion degrades to rule-based output, is NOT logged as a provider failure, and never reaches the provider', async () => {
  const { layer, provider } = budgetLayer(0);
  const records: { message: string; fields: LogFields }[] = [];
  const hybrid = new HybridKnowledgeExtractor(new AiKnowledgeExtractor(layer), recordingLogger(records), { mode: 'always' });
  const result = await hybrid.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(
    result.value.nodes.some((n) => n.isUnitPrimary),
    'rule-based output is still produced',
  );
  assert.ok(!result.value.nodes.some((n) => n.localId === 'i1'), 'no AI-derived node when inference was denied');
  assert.equal(provider.callLog.length, 0);
  const warn = records.find((r) => r.message.includes('falling back'));
  assert.equal(warn?.fields['inferenceDenied'], 'budget_exhausted');
  assert.equal(warn?.fields['errorCode'], 'XO_AI_INFERENCE_DENIED');
  assert.deepEqual(layer.inferenceReport().denials, { budget_exhausted: 1 });
});

test('an ample budget leaves existing hybrid extraction behaviour unchanged', async () => {
  const { layer } = budgetLayer(1_000_000);
  const result = await new HybridKnowledgeExtractor(new AiKnowledgeExtractor(layer), undefined, { mode: 'always' }).extract(makeUnit());
  assert.ok(result.ok);
  if (result.ok) assert.ok(result.value.nodes.some((n) => n.localId === 'i1'));
});

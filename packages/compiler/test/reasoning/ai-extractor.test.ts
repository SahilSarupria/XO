import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { ReasoningExtractionOutput, DecisionGraphExtractionOutput, ConstraintExtractionOutput } from '@xo/ai-core';
import { AiReasoningExtractor } from '../../src/reasoning/ai-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';

function makeUnit(): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Approval Policy',
    semanticType: 'clause',
    content: 'If the customer is eligible, approve the request.',
    provenance: { documentPath: 'doc.pdf', pages: [2], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.85,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

const EMPTY_REASONING: ReasoningExtractionOutput = { steps: [], tradeoffs: [], exceptions: [], alternativePaths: [], failureModes: [] };
const EMPTY_DECISION: DecisionGraphExtractionOutput = { decisions: [], branches: [], escalationPaths: [], riskThresholds: [], fallbacks: [] };
const EMPTY_CONSTRAINT: ConstraintExtractionOutput = { constraints: [], confidenceBoundaries: [] };

function makeLayer(reasoning: ReasoningExtractionOutput, decision: DecisionGraphExtractionOutput, constraint: ConstraintExtractionOutput): AiCapabilityLayer {
  const reasoningProvider = new ScriptableTestProvider('reasoning-provider', [{ kind: 'success', response: jsonResponse(reasoning) }]);
  const decisionProvider = new ScriptableTestProvider('decision-provider', [{ kind: 'success', response: jsonResponse(decision) }]);
  const constraintProvider = new ScriptableTestProvider('constraint-provider', [{ kind: 'success', response: jsonResponse(constraint) }]);
  return new AiCapabilityLayer({
    providers: [reasoningProvider, decisionProvider, constraintProvider],
    policy: {
      rules: [
        { capability: 'extractReasoning', providerOrder: ['reasoning-provider'], modelByProvider: { 'reasoning-provider': 'test-model' } },
        { capability: 'extractDecisionGraph', providerOrder: ['decision-provider'], modelByProvider: { 'decision-provider': 'test-model' } },
        { capability: 'extractConstraints', providerOrder: ['constraint-provider'], modelByProvider: { 'constraint-provider': 'test-model' } },
      ],
    },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
}

test('maps extractReasoning steps into justification candidates', async () => {
  const output: ReasoningExtractionOutput = { ...EMPTY_REASONING, steps: [{ id: 's1', premise: 'the contract lacks a signature', conclusion: 'the agreement is voided', confidence: 0.85 }] };
  const extractor = new AiReasoningExtractor(makeLayer(output, EMPTY_DECISION, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.nodes.find((n) => n.nodeType === 'justification');
  assert.ok(node);
  assert.equal(node!.rationale, 'the contract lacks a signature');
  assert.equal(node!.outcome, 'the agreement is voided');
  assert.equal(node!.confidence, 0.85);
});

test('maps extractReasoning exceptions into exception candidates', async () => {
  const output: ReasoningExtractionOutput = { ...EMPTY_REASONING, exceptions: [{ condition: 'force majeure applies', deviation: 'the deadline is waived' }] };
  const extractor = new AiReasoningExtractor(makeLayer(output, EMPTY_DECISION, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.nodes.find((n) => n.nodeType === 'exception');
  assert.ok(node);
  assert.equal(node!.condition, 'force majeure applies');
});

test('maps extractReasoning alternativePaths into alternative candidates, linked to their steps via supports edges', async () => {
  const output: ReasoningExtractionOutput = {
    ...EMPTY_REASONING,
    steps: [{ id: 's1', premise: 'p', conclusion: 'c', confidence: 0.8 }],
    alternativePaths: [{ description: 'expedited review', whenApplicable: 'the case is urgent', stepIds: ['s1'] }],
  };
  const extractor = new AiReasoningExtractor(makeLayer(output, EMPTY_DECISION, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const altNode = result.value.nodes.find((n) => n.nodeType === 'alternative');
  assert.ok(altNode);
  const edge = result.value.edges.find((e) => e.type === 'supports');
  assert.ok(edge);
});

test('maps extractDecisionGraph decisions and dependsOnDecisionIds into decision candidates and depends_on edges', async () => {
  const output: DecisionGraphExtractionOutput = {
    ...EMPTY_DECISION,
    decisions: [
      { id: 'd1', question: 'Is the customer eligible?', dependsOnDecisionIds: [] },
      { id: 'd2', question: 'Should we approve?', dependsOnDecisionIds: ['d1'] },
    ],
  };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, output, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const decisionNodes = result.value.nodes.filter((n) => n.nodeType === 'decision');
  assert.equal(decisionNodes.length, 2);
  const dependsEdge = result.value.edges.find((e) => e.type === 'depends_on');
  assert.ok(dependsEdge);
});

test('maps extractDecisionGraph branches into decision candidates with condition_of and leads_to edges', async () => {
  const output: DecisionGraphExtractionOutput = {
    ...EMPTY_DECISION,
    decisions: [
      { id: 'd1', question: 'Approve?', dependsOnDecisionIds: [] },
      { id: 'd2', question: 'Escalate?', dependsOnDecisionIds: [] },
    ],
    branches: [{ decisionId: 'd1', condition: 'amount > 1000', outcome: 'requires manager approval', leadsToDecisionId: 'd2' }],
  };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, output, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.edges.some((e) => e.type === 'condition_of'));
  assert.ok(result.value.edges.some((e) => e.type === 'leads_to'));
});

test('maps extractDecisionGraph escalationPaths into escalation candidates (mapping onto XOIR escalation_rule downstream)', async () => {
  const output: DecisionGraphExtractionOutput = { ...EMPTY_DECISION, escalationPaths: [{ triggerCondition: 'fraud is suspected', escalateTo: 'compliance team' }] };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, output, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.nodes.find((n) => n.nodeType === 'escalation');
  assert.ok(node);
  assert.equal(node!.condition, 'fraud is suspected');
  assert.equal(node!.action, 'compliance team');
});

test('maps extractDecisionGraph riskThresholds into risk_threshold candidates', async () => {
  const output: DecisionGraphExtractionOutput = { ...EMPTY_DECISION, riskThresholds: [{ metric: 'transaction amount', thresholdDescription: 'above $10,000', aboveThresholdAction: 'require dual approval' }] };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, output, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.nodes.find((n) => n.nodeType === 'risk_threshold');
  assert.ok(node);
  assert.equal(node!.metadata.metric, 'transaction amount');
});

test('maps extractDecisionGraph fallbacks into rule candidates, linked to the failing decision when it is present in the same response', async () => {
  const output: DecisionGraphExtractionOutput = {
    ...EMPTY_DECISION,
    decisions: [{ id: 'd1', question: 'Approve automatically?', dependsOnDecisionIds: [] }],
    fallbacks: [{ whenDecisionFails: 'd1', fallbackAction: 'route to manual review' }],
  };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, output, EMPTY_CONSTRAINT));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const fallbackNode = result.value.nodes.find((n) => n.nodeType === 'rule');
  assert.ok(fallbackNode);
  assert.ok(result.value.edges.some((e) => e.type === 'condition_of'));
});

test('maps extractConstraints constraints into policy candidates with severity/kind/applicability in metadata', async () => {
  const output: ConstraintExtractionOutput = { constraints: [{ kind: 'regulatory', rule: 'Must retain records for 7 years', severity: 'blocking', applicability: 'all financial contracts' }], confidenceBoundaries: [] };
  const extractor = new AiReasoningExtractor(makeLayer(EMPTY_REASONING, EMPTY_DECISION, output));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.nodes.find((n) => n.nodeType === 'policy');
  assert.ok(node);
  assert.equal(node!.metadata.severity, 'blocking');
  assert.equal(node!.metadata.constraintKind, 'regulatory');
});

test('one capability failing does not prevent the other two from contributing candidates', async () => {
  const failingReasoningProvider = new ScriptableTestProvider('reasoning-provider', [{ kind: 'failure', error: new Error('provider down') }]);
  const decisionProvider = new ScriptableTestProvider('decision-provider', [{ kind: 'success', response: jsonResponse({ ...EMPTY_DECISION, escalationPaths: [{ triggerCondition: 'x', escalateTo: 'y' }] }) }]);
  const constraintProvider = new ScriptableTestProvider('constraint-provider', [{ kind: 'success', response: jsonResponse(EMPTY_CONSTRAINT) }]);
  const layer = new AiCapabilityLayer({
    providers: [failingReasoningProvider, decisionProvider, constraintProvider],
    policy: {
      rules: [
        { capability: 'extractReasoning', providerOrder: ['reasoning-provider'], modelByProvider: { 'reasoning-provider': 'test-model' } },
        { capability: 'extractDecisionGraph', providerOrder: ['decision-provider'], modelByProvider: { 'decision-provider': 'test-model' } },
        { capability: 'extractConstraints', providerOrder: ['constraint-provider'], modelByProvider: { 'constraint-provider': 'test-model' } },
      ],
    },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  const extractor = new AiReasoningExtractor(layer);
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.nodes.some((n) => n.nodeType === 'escalation'));
});

test('all three capabilities failing surfaces as an error Result', async () => {
  const failing = (id: string) => new ScriptableTestProvider(id as never, [{ kind: 'failure', error: new Error('down') }]);
  const layer = new AiCapabilityLayer({
    providers: [failing('reasoning-provider'), failing('decision-provider'), failing('constraint-provider')],
    policy: {
      rules: [
        { capability: 'extractReasoning', providerOrder: ['reasoning-provider'], modelByProvider: { 'reasoning-provider': 'test-model' } },
        { capability: 'extractDecisionGraph', providerOrder: ['decision-provider'], modelByProvider: { 'decision-provider': 'test-model' } },
        { capability: 'extractConstraints', providerOrder: ['constraint-provider'], modelByProvider: { 'constraint-provider': 'test-model' } },
      ],
    },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
  });
  const extractor = new AiReasoningExtractor(layer);
  const result = await extractor.extract(makeUnit());
  assert.equal(result.ok, false);
});

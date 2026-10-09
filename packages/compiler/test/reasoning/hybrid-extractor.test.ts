import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer, ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import type { ReasoningExtractionOutput, DecisionGraphExtractionOutput, ConstraintExtractionOutput } from '@xo/ai-core';
import { HybridReasoningExtractor } from '../../src/reasoning/hybrid-extractor.js';
import { AiReasoningExtractor } from '../../src/reasoning/ai-extractor.js';
import type { Logger, LogLevel } from '@xo/logger';
import type { ExperienceUnit } from '../../src/semantic/types.js';

/**
 * Offline, fully deterministic coverage for `HybridReasoningExtractor` —
 * the fallback/corroboration logic sitting between the always-on
 * `RuleBasedReasoningExtractor` and an optional `AiReasoningExtractor`.
 * `ai-extractor.test.ts` already covers `AiReasoningExtractor` mapping
 * correctness in isolation (11 tests); this file covers the *hybrid*
 * behavior on top of it — what the compiler actually gets when both run
 * together, or when AI is absent/fails/misbehaves — none of it requiring
 * network access, an API key, or any real provider. Every AI response
 * here comes from `ScriptableTestProvider` (the same seam
 * `ai-extractor.test.ts` and `@xo/ai-core`'s own `router.test.ts` use),
 * never `AnthropicProvider` or any other network-backed provider.
 *
 * Layer 2A (P0.9 Beta, see `benchmark/CHANGELOG.md`): this is the offline
 * test coverage required before the real, credentialed Aastha AI run —
 * which is currently BLOCKED (no provider credential in this
 * environment) and is NOT what these tests substitute for. These tests
 * establish that the wiring and trust boundary behave correctly; they
 * say nothing about what a real model would actually find in Aastha.
 */

function makeUnit(content = 'If the customer is eligible, approve the request.'): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Approval Policy',
    headingTitle: undefined,
    semanticType: 'clause',
    content,
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

/** Builds an `AiCapabilityLayer` wired to `ScriptableTestProvider`s only — no network-backed provider is ever constructed in this file. */
function makeAiCore(
  reasoning: { kind: 'success'; output: ReasoningExtractionOutput } | { kind: 'failure'; error: unknown },
  decision: { kind: 'success'; output: DecisionGraphExtractionOutput } | { kind: 'failure'; error: unknown },
  constraint: { kind: 'success'; output: ConstraintExtractionOutput } | { kind: 'failure'; error: unknown },
): AiCapabilityLayer {
  const toOutcome = (spec: { kind: 'success'; output: unknown } | { kind: 'failure'; error: unknown }) => (spec.kind === 'success' ? { kind: 'success' as const, response: jsonResponse(spec.output) } : { kind: 'failure' as const, error: spec.error });
  const reasoningProvider = new ScriptableTestProvider('reasoning-provider', [toOutcome(reasoning)]);
  const decisionProvider = new ScriptableTestProvider('decision-provider', [toOutcome(decision)]);
  const constraintProvider = new ScriptableTestProvider('constraint-provider', [toOutcome(constraint)]);
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

// --- 1. AI unavailable/unconfigured ---

/** A minimal, fully-typed in-memory `Logger` for asserting on emitted log records without a real sink. */
class RecordingLogger implements Logger {
  readonly level: LogLevel = 'trace';
  readonly records: { level: LogLevel; message: string }[] = [];
  private record(level: LogLevel, message: string): void {
    this.records.push({ level, message });
  }
  trace(message: string): void {
    this.record('trace', message);
  }
  debug(message: string): void {
    this.record('debug', message);
  }
  info(message: string): void {
    this.record('info', message);
  }
  warn(message: string): void {
    this.record('warn', message);
  }
  error(message: string): void {
    this.record('error', message);
  }
  fatal(message: string): void {
    this.record('fatal', message);
  }
  child(): Logger {
    return this;
  }
}

test('AI absent (no aiCore configured): rule-based reasoning only, no crash, no AI metadata anywhere', async () => {
  const extractor = new HybridReasoningExtractor(); // no aiExtractor — the exact "unconfigured" shape reasoning-extractor.ts produces when options.aiCore is omitted
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.nodes.length > 0, 'the rule-based candidate for this IF/THEN sentence must still be produced');
  for (const node of result.value.nodes) assert.ok(!Object.values(node.metadata).some((v) => v.startsWith('ai:')), 'no AI-sourced metadata when AI was never configured');
});

// --- 2. AI extractor failure ---

test('AI provider throws for every capability: rule-based result is preserved, extraction still succeeds', async () => {
  const aiCore = makeAiCore({ kind: 'failure', error: new Error('provider unreachable') }, { kind: 'failure', error: new Error('provider unreachable') }, { kind: 'failure', error: new Error('provider unreachable') });
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok, 'a fully-failed AI extractor must not fail the whole unit — rule-based fallback applies');
  if (!result.ok) return;
  assert.ok(result.value.nodes.length > 0, 'the rule-based candidate must still be present');
  assert.ok(!result.value.nodes.some((n) => Object.values(n.metadata).some((v) => v.startsWith('ai:'))), 'no AI-sourced node when every AI capability failed');
});

test('a warning is logged (not thrown) when AI extraction fails for a unit, matching existing design', async () => {
  const logger = new RecordingLogger();
  const aiCore = makeAiCore({ kind: 'failure', error: new Error('provider unreachable') }, { kind: 'failure', error: new Error('provider unreachable') }, { kind: 'failure', error: new Error('provider unreachable') });
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore), logger);
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  assert.ok(logger.records.some((r) => r.level === 'warn' && r.message.includes('AI reasoning extraction unavailable')), 'the existing warn-and-fall-back log line must fire');
});

// --- 3. Malformed AI output ---

test('AI returns unparseable (non-JSON) text: rejected safely, rule-based result preserved, no fabricated node', async () => {
  const malformedResponse = { text: 'this is not valid json {{{', usage: { inputTokens: 5, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' as const };
  const reasoningProvider = new ScriptableTestProvider('reasoning-provider', [{ kind: 'success', response: malformedResponse }]);
  const decisionProvider = new ScriptableTestProvider('decision-provider', [{ kind: 'success', response: malformedResponse }]);
  const constraintProvider = new ScriptableTestProvider('constraint-provider', [{ kind: 'success', response: malformedResponse }]);
  const aiCore = new AiCapabilityLayer({
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
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok, 'malformed AI output must degrade to rule-based, not fail the unit');
  if (!result.ok) return;
  assert.ok(result.value.nodes.length > 0, 'the rule-based candidate must still be present');
  assert.ok(!result.value.nodes.some((n) => Object.values(n.metadata).some((v) => v.startsWith('ai:'))), 'no node fabricated from the unparseable AI response');
});

test('AI returns a response that does not satisfy the declared output schema: rejected safely, rule-based result preserved', async () => {
  // Valid JSON, wrong shape — `decisions` items missing the required `question`/`dependsOnDecisionIds` fields router.ts's schema validation requires.
  const schemaInvalid = { text: JSON.stringify({ decisions: [{ id: 'd1' }], branches: [], escalationPaths: [], riskThresholds: [], fallbacks: [] }), usage: { inputTokens: 5, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' as const };
  const decisionProvider = new ScriptableTestProvider('decision-provider', [{ kind: 'success', response: schemaInvalid }]);
  const reasoningProvider = new ScriptableTestProvider('reasoning-provider', [{ kind: 'success', response: jsonResponse(EMPTY_REASONING) }]);
  const constraintProvider = new ScriptableTestProvider('constraint-provider', [{ kind: 'success', response: jsonResponse(EMPTY_CONSTRAINT) }]);
  const aiCore = new AiCapabilityLayer({
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
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(!result.value.nodes.some((n) => n.metadata.source === 'ai:extractDecisionGraph'), 'a schema-invalid decision must not become a node — router.ts\'s validation gate must reject it, not this extractor silently trusting it');
});

// --- 4. Low-confidence AI result: preserved as data, never specially promoted or hidden ---

test('a low-confidence AI-only candidate is neither promoted to higher confidence nor dropped — it reaches the graph exactly as scored, no new confidence policy invented', async () => {
  // A decision unrelated to the rule-based candidate (different canonicalLabel), so it does NOT corroborate — this isolates "how is a lone, low-confidence AI candidate treated" from merge-averaging.
  const decision: DecisionGraphExtractionOutput = { ...EMPTY_DECISION, decisions: [{ id: 'd1', question: 'an unrelated ai-only decision the rule-based extractor never finds', dependsOnDecisionIds: [] }] };
  const aiCore = makeAiCore({ kind: 'success', output: EMPTY_REASONING }, { kind: 'success', output: decision }, { kind: 'success', output: EMPTY_CONSTRAINT });
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;
  const aiOnly = result.value.nodes.find((n) => n.canonicalLabel === 'an unrelated ai-only decision the rule-based extractor never finds');
  assert.ok(aiOnly, 'the AI-only candidate must still surface as a candidate — it is not silently dropped for being AI-sourced');
  // AiReasoningExtractor's AI_EDGE_CONFIDENCE is 0.7 — a deliberately not-maximal confidence, unchanged by hybrid merging when there is nothing to corroborate against.
  assert.equal(aiOnly!.confidence, 0.7, 'the AI-assigned confidence must reach the graph unmodified — no automatic promotion to a higher/"authoritative" value');
});

// --- 5. Rule + AI corroboration ---

test('when rule-based and AI independently find the same decision, they merge into one node per existing match-key semantics, confidence averages, and structural validation still runs', async () => {
  // Rule-based parses "If the customer is eligible, approve the request." into nodeType 'decision',
  // canonicalLabel "the customer is eligible => approve the request", confidence 0.8 (rule-pattern-parser.ts).
  // Scripting the AI decision-graph response's `question` to the identical string (case/whitespace only
  // need match per normalizeReasoningLabel) makes AiReasoningExtractor produce a corroborating candidate:
  // canonicalLabel = decision.question, confidence = AI_EDGE_CONFIDENCE (0.7).
  const decision: DecisionGraphExtractionOutput = { ...EMPTY_DECISION, decisions: [{ id: 'd1', question: 'The Customer Is Eligible => Approve The Request', dependsOnDecisionIds: [] }] };
  const aiCore = makeAiCore({ kind: 'success', output: EMPTY_REASONING }, { kind: 'success', output: decision }, { kind: 'success', output: EMPTY_CONSTRAINT });
  const extractor = new HybridReasoningExtractor(new AiReasoningExtractor(aiCore));
  const result = await extractor.extract(makeUnit());
  assert.ok(result.ok);
  if (!result.ok) return;

  const matching = result.value.nodes.filter((n) => n.nodeType === 'decision' && n.canonicalLabel.toLowerCase().replace(/\s+/g, ' ').trim() === 'the customer is eligible => approve the request');
  assert.equal(matching.length, 2, 'both the rule-based and the AI candidate are present as two separate CANDIDATES at this pre-merge stage — merging happens in mergeReasoningNodes, one stage later, not inside the extractor');

  // Confirm the merge itself (mergeReasoningNodes), exercised the same way extractReasoningGraph would call it.
  const { mergeReasoningNodes } = await import('../../src/reasoning/merge.js');
  const merged = mergeReasoningNodes([{ unit: makeUnit(), extraction: result.value }]);
  const mergedMatches = merged.nodes.filter((n) => n.nodeType === 'decision' && n.canonicalLabel.toLowerCase() === 'the customer is eligible => approve the request');
  assert.equal(mergedMatches.length, 1, 'existing merge semantics (computeReasoningMatchKey) fold the two corroborating candidates into exactly one node');
  const node = mergedMatches[0]!;
  assert.equal(node.confidence, 0.75, 'confidence averages the two corroborating candidates (0.8 rule-based, 0.7 AI) — unchanged existing behavior, not a new policy');
  assert.equal(node.provenance.length, 2, 'both candidates\' provenance entries are kept (provenance is an array, additive) even though the nodes merged into one');

  // Known, documented limitation (not fixed here — see benchmark/CHANGELOG.md's Layer 2A entry and merge.ts's
  // doc comment): Object.assign(metadata, c.metadata) means the final metadata.source reflects only the LAST
  // candidate folded into the group, not both producers. This test documents that behavior rather than hiding it.
  assert.equal(node.metadata.source, 'ai:extractDecisionGraph', 'current (documented, unfixed) behavior: last-writer-wins metadata does not explicitly represent multi-producer corroboration');
});

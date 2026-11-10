import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiCapabilityLayer,
  InferenceGuard,
  InMemoryCapabilityCache,
  ScriptableTestProvider,
  jsonResponse,
  type KnowledgeExtractionOutput,
} from '@xo/ai-core';
import type { Logger, LogFields } from '@xo/logger';
import { ErrorCode } from '@xo/errors';
import { AiKnowledgeExtractor } from '../../src/knowledge/ai-extractor.js';
import { HybridKnowledgeExtractor } from '../../src/knowledge/hybrid-extractor.js';
import {
  DEFAULT_ESCALATION_POLICY,
  decideEscalation,
  resolveEscalationPolicy,
  validateEscalationPolicy,
} from '../../src/knowledge/escalation-policy.js';
import { MODEL_REJECTION_CODES, validateModelExtraction } from '../../src/knowledge/model-validation.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';

// ---- builders --------------------------------------------------------------------------------------
function unit(over: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Premium payment',
    semanticType: 'general',
    // Starts lowercase on purpose: a capitalized first word is itself picked up as a (weak) single-word entity candidate.
    content: 'premiums are payable annually under this agreement and policy.',
    provenance: { documentPath: 'doc.pdf', pages: [1], sectionPath: ['A'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.5,
    relationships: [],
    documentReferences: [],
    metadata: {},
    ...over,
  };
}
/** An explicit defined term: the extractor's only 0.85 tier. */
const definedTermUnit = (): ExperienceUnit =>
  unit({
    title: 'Definitions',
    semanticType: 'definition',
    confidence: 0.9,
    content: '"Confidential Information" means non-public information disclosed to the Receiving Party.',
  });

function node(over: Partial<CandidateKnowledgeNode>): CandidateKnowledgeNode {
  return {
    localId: 'n',
    semanticType: 'entity',
    label: 'Acme Holdings',
    confidence: 0.65,
    provenance: {
      experienceUnitId: 'unit-1',
      documentPath: 'doc.pdf',
      pages: [1],
      sectionPath: [],
      charOffsetRange: [0, 5],
      confidence: 0.65,
    },
    metadata: {},
    isUnitPrimary: false,
    sourceUnitId: 'unit-1',
    ...over,
  };
}
const primary = (over: Partial<CandidateKnowledgeNode> = {}): CandidateKnowledgeNode =>
  node({
    localId: 'primary',
    semanticType: 'definition',
    label: 'Confidential Information',
    confidence: 0.85,
    isUnitPrimary: true,
    ...over,
  });

const GOOD: KnowledgeExtractionOutput = {
  items: [{ id: 'i1', type: 'concept', statement: 'Premium payment terms', domain: 'insurance', confidence: 0.8 }],
  relationships: [],
};

function layerWith(
  responses: KnowledgeExtractionOutput[],
  scope?: ReturnType<InferenceGuard['beginRun']>,
  cache?: InMemoryCapabilityCache,
  usage = { inputTokens: 10, outputTokens: 10 },
) {
  const provider = new ScriptableTestProvider(
    'anthropic',
    responses.map((o) => ({ kind: 'success' as const, response: jsonResponse(o, usage) })),
  );
  const aiCore = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
    ...(scope ? { inferenceScope: scope } : {}),
    ...(cache ? { cache } : {}),
  });
  return { provider, aiCore, extractor: new AiKnowledgeExtractor(aiCore) };
}
function recorder() {
  const records: { message: string; fields: LogFields }[] = [];
  const make = (): Logger => ({
    level: 'trace',
    trace() {},
    debug() {},
    info() {},
    warn: (message: string, fields?: LogFields) => void records.push({ message, fields: fields ?? {} }),
    error() {},
    fatal() {},
    child: () => make(),
  });
  return { logger: make(), records };
}
/** The EXPERIMENTAL confidence gate, only reachable by explicit opt-in (NOT SUPPORTED by evidence). */
const GATED = { ...DEFAULT_ESCALATION_POLICY, mode: 'gated' } as const;
const bounded = (maxTotalTokens = 1_000_000) => new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens }).beginRun();

// ---- the decision table (EXPERIMENTAL gated mode; the default is covered further below) -----------
test('GATED STRONG: an explicit defined term with clean, non-competing candidates does NOT escalate', () => {
  const u = definedTermUnit();
  const d = decideEscalation(u, [primary(), node({ label: 'Receiving Party', localId: 'e1' })], GATED);
  assert.deepEqual({ escalate: d.escalate, reason: d.reason }, { escalate: false, reason: 'strong' });
});

test('NO CANDIDATE: only a weak fallback primary and no entities escalates', () => {
  const d = decideEscalation(unit(), [primary({ semanticType: 'concept', label: 'Premium payment', confidence: 0.5 })], GATED);
  assert.deepEqual({ escalate: d.escalate, reason: d.reason }, { escalate: true, reason: 'no_candidate' });
});

test('LOW CONFIDENCE: best usable candidate below the threshold escalates; raising/lowering the threshold changes the decision', () => {
  const nodes = [
    primary({ semanticType: 'obligation', confidence: 0.7, label: 'Duty' }),
    node({ label: 'Acme Holdings', confidence: 0.65 }),
  ];
  assert.equal(decideEscalation(unit(), nodes, GATED).reason, 'low_confidence');
  assert.equal(decideEscalation(unit(), nodes, { ...GATED, confidenceThreshold: 0.7 }).reason, 'strong');
});

test('AMBIGUOUS: competing candidates the rules cannot settle escalate even when a candidate is strong', () => {
  const nodes = [
    primary({ semanticType: 'concept', label: 'Acme Holdings', confidence: 0.85 }),
    node({ semanticType: 'entity', label: 'acme holdings', confidence: 0.8 }),
  ];
  const d = decideEscalation(unit(), nodes, GATED);
  assert.deepEqual({ escalate: d.escalate, reason: d.reason }, { escalate: true, reason: 'ambiguous' });
});

test('AMBIGUITY resolved deterministically: a clear confidence gap, or an explicit specificity ordering, does not escalate', () => {
  const gap = [
    primary({ semanticType: 'concept', label: 'Acme Holdings', confidence: 0.85 }),
    node({ semanticType: 'entity', label: 'Acme Holdings', confidence: 0.65 }),
  ];
  assert.equal(decideEscalation(unit(), gap, GATED).reason, 'strong');
  const specific = [
    primary({ semanticType: 'concept', label: 'Acme Corp', confidence: 0.85 }),
    node({ semanticType: 'organization', label: 'Acme Corp', confidence: 0.8 }),
  ];
  assert.equal(decideEscalation(unit(), specific, GATED).reason, 'strong');
});

test('overlapping spans with different types are competition; the same type is just a duplicate', () => {
  const overlap = [
    primary(),
    node({
      localId: 'a',
      semanticType: 'entity',
      label: 'Acme',
      confidence: 0.8,
      provenance: { ...node({}).provenance, charOffsetRange: [0, 10] },
    }),
    node({
      localId: 'b',
      semanticType: 'organization',
      label: 'Acme Corp',
      confidence: 0.82,
      provenance: { ...node({}).provenance, charOffsetRange: [5, 15] },
    }),
  ];
  assert.equal(
    decideEscalation(unit(), overlap, { ...GATED, ambiguityMargin: 0.1 }).reason,
    'strong',
    'organization outranks entity by specificity',
  );
  const dup = [primary(), node({ localId: 'a', label: 'Acme' }), node({ localId: 'b', label: 'Acme' })];
  assert.equal(decideEscalation(unit(), dup, GATED).reason, 'strong');
});

test('a malformed candidate (line break, comma, too many words) never makes a unit look strong', () => {
  for (const label of [
    'Trust Clause\n\nCyber Risk Exclusion Clause',
    'Policy, the Insurer',
    'one two three four five six seven eight nine',
  ]) {
    const d = decideEscalation(unit(), [primary({ semanticType: 'concept', label, confidence: 0.9 })], GATED);
    assert.equal(d.escalate, true, label);
    assert.equal(d.reason, 'no_candidate');
  }
});

test('FRAGMENT SKIP: the default skips only empty/whitespace units; larger minContentWords is opt-in', () => {
  const tiny = unit({ content: 'Insured Details:' });
  assert.equal(DEFAULT_ESCALATION_POLICY.minContentWords, 1);
  assert.deepEqual(
    { e: decideEscalation(tiny, [primary({ confidence: 0.5 })]).escalate, r: decideEscalation(tiny, []).reason },
    { e: true, r: 'always' },
    'a short fragment is escalated by default',
  );
  for (const content of ['', '   \n\t ']) {
    const d = decideEscalation(unit({ content }), []);
    assert.deepEqual({ e: d.escalate, r: d.reason }, { e: false, r: 'insufficient_content' }, JSON.stringify(content));
  }
  // Opt-in cut-offs (UNVALIDATED) still work, in either mode.
  assert.equal(decideEscalation(tiny, [], { ...DEFAULT_ESCALATION_POLICY, minContentWords: 4 }).reason, 'insufficient_content');
  assert.equal(decideEscalation(tiny, [primary({ confidence: 0.5 })], { ...GATED, minContentWords: 4 }).reason, 'insufficient_content');
});

test('DEFAULT policy: a strong defined-term unit with clean candidates IS escalated; no confidence or competition suppresses a call', () => {
  const strong = decideEscalation(definedTermUnit(), [primary(), node({ label: 'Receiving Party', localId: 'e1' })]);
  assert.deepEqual({ e: strong.escalate, r: strong.reason, tier: strong.diagnostics?.ruleTier }, { e: true, r: 'always', tier: 'strong' });
  const competing = decideEscalation(unit(), [
    primary({ semanticType: 'concept', label: 'Acme Holdings', confidence: 0.85 }),
    node({ semanticType: 'entity', label: 'acme holdings', confidence: 0.8 }),
  ]);
  assert.deepEqual({ e: competing.escalate, r: competing.reason, c: competing.diagnostics?.competing }, { e: true, r: 'always', c: true });
  assert.equal(DEFAULT_ESCALATION_POLICY.mode, 'always');
});

test('policy config is validated, and resolved from the environment with safe defaults', () => {
  assert.throws(() => validateEscalationPolicy({ ...DEFAULT_ESCALATION_POLICY, confidenceThreshold: 1.5 }), /confidenceThreshold/);
  assert.throws(() => validateEscalationPolicy({ ...DEFAULT_ESCALATION_POLICY, ambiguityMargin: -1 }), /ambiguityMargin/);
  assert.throws(() => validateEscalationPolicy({ ...DEFAULT_ESCALATION_POLICY, minContentWords: 1.5 }), /minContentWords/);
  assert.deepEqual(resolveEscalationPolicy({}), DEFAULT_ESCALATION_POLICY);
  assert.equal(
    resolveEscalationPolicy({ XO_COMPILER_ESCALATION_CONFIDENCE_THRESHOLD: '0.7', XO_COMPILER_ESCALATION_MODE: 'always' }).mode,
    'always',
  );
  assert.throws(() => resolveEscalationPolicy({ XO_COMPILER_ESCALATION_MODE: 'sometimes' }), /gated.*always/);
  assert.throws(() => resolveEscalationPolicy({ XO_COMPILER_ESCALATION_CONFIDENCE_THRESHOLD: 'high' }), /number/);
  assert.equal(DEFAULT_ESCALATION_POLICY.mode, 'always');
  assert.equal(resolveEscalationPolicy({ XO_COMPILER_ESCALATION_MODE: 'gated' }).mode, 'gated');
});

// ---- the hybrid extractor -------------------------------------------------------------------------
test('DEFAULT: a strong defined-term unit is sent to the model (no confidence suppression)', async () => {
  const { provider, extractor } = layerWith([GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor);
  const r = await hybrid.extract(definedTermUnit());
  assert.ok(r.ok);
  assert.equal(provider.callLog.length, 1);
  const rep = hybrid.report();
  assert.deepEqual({ seen: rep.unitsSeen, esc: rep.escalated, skipped: rep.skipped }, { seen: 1, esc: 1, skipped: 0 });
  assert.equal(rep.byReason.always, 1);
  assert.equal(rep.diagnostics.ruleTiers.strong, 1, 'the strong tier is reported as a diagnostic only');
  assert.equal(rep.providerCalls, 1);
});

test('DEFAULT: an empty unit is skipped with no call; a one-word unit is escalated', async () => {
  const { provider, extractor } = layerWith([GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor);
  await hybrid.extract(unit({ content: '   ' }));
  assert.equal(provider.callLog.length, 0);
  assert.equal(hybrid.report().byReason.insufficient_content, 1);
  assert.equal(hybrid.report().skipped, 1);
  await hybrid.extract(unit({ id: 'u2' as ExperienceUnit['id'], content: 'Premiums.' }));
  assert.equal(provider.callLog.length, 1);
  assert.equal(hybrid.report().escalated, 1);
});

test('GATED (experimental opt-in) still works: strong candidates SKIP inference and the skip is reported', async () => {
  const { provider, extractor } = layerWith([GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor, undefined, { mode: 'gated' });
  const r = await hybrid.extract(definedTermUnit());
  assert.ok(r.ok);
  assert.equal(provider.callLog.length, 0);
  assert.equal(hybrid.report().skipped, 1);
  assert.equal(hybrid.report().byReason.strong, 1);
  assert.equal(hybrid.report().modelCallsAttempted, 0);
  assert.equal(hybrid.report().providerCalls, 0);
});

test('GATED: missing / weak candidates escalate and the model result is unioned with the rule result', async () => {
  const missing = layerWith([GOOD]);
  const h1 = new HybridKnowledgeExtractor(missing.extractor, undefined, { mode: 'gated' });
  const r1 = await h1.extract(unit());
  assert.ok(r1.ok && r1.value.nodes.some((n) => n.localId === 'i1') && r1.value.nodes.some((n) => n.isUnitPrimary));
  assert.equal(h1.report().byReason.no_candidate, 1);

  const weak = layerWith([GOOD]);
  const h2 = new HybridKnowledgeExtractor(weak.extractor, undefined, { mode: 'gated' });
  const r2 = await h2.extract(unit({ content: 'Premiums are payable to Acme Holdings annually under this agreement.' }));
  assert.ok(r2.ok && r2.value.nodes.some((n) => n.localId === 'i1'));
  assert.equal(h2.report().byReason.low_confidence, 1);
});

test('GATED: ambiguous rule output escalates', async () => {
  const { provider, extractor } = layerWith([GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor, undefined, { mode: 'gated', confidenceThreshold: 0.6 });
  const r = await hybrid.extract(
    unit({ title: 'Acme Holdings', confidence: 0.7, content: 'Acme Holdings agrees to the terms set out below.' }),
  );
  assert.ok(r.ok);
  assert.equal(hybrid.report().byReason.ambiguous, 1);
  assert.equal(provider.callLog.length, 1);
});

test('mode "always" is the default semantics: every unit with content escalates, reason "always"', async () => {
  const { provider, extractor } = layerWith([GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor, undefined, { mode: 'always' });
  await hybrid.extract(definedTermUnit());
  assert.equal(provider.callLog.length, 1);
  assert.equal(hybrid.report().byReason.always, 1);
});

test('BUDGET DENIAL prevents the call, stays explicit (reason logged and counted), and rule output is kept', async () => {
  const { provider, extractor, aiCore } = layerWith([GOOD], bounded(0));
  const { logger, records } = recorder();
  const hybrid = new HybridKnowledgeExtractor(extractor, logger);
  const r = await hybrid.extract(unit());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.value.nodes.every((n) => n.extractorName === 'rule-based'));
  assert.equal(provider.callLog.length, 0);
  assert.equal(hybrid.report().outcomes.denied, 1);
  assert.equal(hybrid.report().outcomes.accepted, undefined);
  const warn = records.find((x) => x.message.includes('unavailable'));
  assert.equal(warn?.fields['inferenceDenied'], 'budget_exhausted');
  assert.equal(warn?.fields['errorCode'], ErrorCode.AI_INFERENCE_DENIED);
  assert.equal(warn?.fields['escalationReason'], 'always');
  assert.equal(hybrid.report().providerCalls, 0, 'a denied call obtained nothing from the provider');
  assert.deepEqual(aiCore.inferenceReport().denials, { budget_exhausted: 1 });
});

test('every escalation draws on the SAME compile spend guard: only as many calls as the budget allows', async () => {
  // Each call really costs 4000 tokens. The first reserves 4096 and spends 4000; the second is clamped to the 500 left and also spends 4000;
  // by the third the budget is exhausted, so it is refused without contacting the provider.
  const { provider, extractor, aiCore } = layerWith([GOOD, GOOD, GOOD], bounded(4500), undefined, {
    inputTokens: 3000,
    outputTokens: 1000,
  });
  const hybrid = new HybridKnowledgeExtractor(extractor);
  for (const id of ['u1', 'u2', 'u3'])
    await hybrid.extract(unit({ id: id as ExperienceUnit['id'], content: `premiums ${id} are payable annually under this agreement.` }));
  assert.equal(provider.callLog.length, 2, 'a full grant, then the clamped remainder, then nothing');
  assert.equal(hybrid.report().outcomes.denied, 1);
  assert.equal(aiCore.inferenceReport().denials.budget_exhausted, 1);
  assert.equal(hybrid.report().providerCalls, provider.callLog.length, 'providerCalls equals the real provider call count');
});

test('INVALID model output is rejected whole (not silently accepted); the rule result stands', async () => {
  const ungrounded: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'concept', statement: 'Quantum chromodynamics lattice', domain: 'x', confidence: 0.9 }],
    relationships: [],
  };
  const dangling: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'concept', statement: 'Premium payment terms', domain: 'x', confidence: 0.9 }],
    relationships: [{ type: 'references', fromItemId: 'i1', toItemId: 'ghost' }],
  };
  for (const bad of [ungrounded, dangling]) {
    const { extractor } = layerWith([bad]);
    const { logger, records } = recorder();
    const hybrid = new HybridKnowledgeExtractor(extractor, logger);
    const r = await hybrid.extract(unit());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(!r.value.nodes.some((n) => n.localId === 'i1'), 'rejected output must not appear');
    assert.equal(hybrid.report().outcomes.rejected_invalid, 1);
    assert.equal(hybrid.report().outcomes.accepted, undefined);
    assert.ok(records.some((x) => x.message.includes('failed validation')));
    assert.equal(hybrid.report().providerCalls, 1, 'a rejected answer was still obtained from the provider');
  }
});

test('REJECTION DIAGNOSTICS: fixed codes only, per-unit and aggregate; no label, id, unit text or model output anywhere in the report or logs', async () => {
  const SECRET_LABEL = 'Quantum chromodynamics lattice';
  const SECRET_ID = 'secret-local-id-xyz';
  const bad: KnowledgeExtractionOutput = {
    items: [
      { id: SECRET_ID, type: 'concept', statement: SECRET_LABEL, domain: 'x', confidence: 0.9 },
      { id: SECRET_ID, type: 'concept', statement: 'Premium payment terms', domain: 'x', confidence: 0.9 },
    ],
    relationships: [{ type: 'references', fromItemId: SECRET_ID, toItemId: 'ghost-node-id' }],
  };
  const { provider, extractor } = layerWith([bad]);
  const { logger, records } = recorder();
  const hybrid = new HybridKnowledgeExtractor(extractor, logger);
  const u = unit({ content: 'premiums are payable annually under this agreement; confidential banana paragraph.' });
  const r = await hybrid.extract(u);
  assert.ok(r.ok);
  const rep = hybrid.report();
  assert.equal(rep.outcomes.rejected_invalid, 1);
  assert.deepEqual(rep.rejections, { duplicate_local_id: 1, dangling_edge: 1, ungrounded_label: 1 });
  assert.deepEqual(rep.rejectedUnits, [{ unitId: u.id, codes: ['duplicate_local_id', 'dangling_edge', 'ungrounded_label'] }]);
  assert.equal(rep.providerCalls, provider.callLog.length);
  const dump = JSON.stringify({ rep, logs: records });
  for (const leaked of [SECRET_LABEL, SECRET_ID, 'ghost-node-id', 'banana', 'premiums are payable', 'Premium payment terms'])
    assert.ok(!dump.includes(leaked), `leaked: ${leaked}`);
});

test('REPORT carries no unit text or label text on any path (accepted, cache replay, memoized, denied, failed)', async () => {
  const cache = new InMemoryCapabilityCache();
  const u = unit({ content: 'premiums are payable annually under this agreement; zanzibar marker text.' });
  const a = layerWith([GOOD], bounded(), cache);
  const h1 = new HybridKnowledgeExtractor(a.extractor);
  await h1.extract(u);
  await h1.extract(u);
  const b = layerWith([], bounded(), cache);
  const h2 = new HybridKnowledgeExtractor(b.extractor);
  await h2.extract(u);
  const c = layerWith([GOOD], bounded(0));
  const h3 = new HybridKnowledgeExtractor(c.extractor);
  await h3.extract(u);
  for (const h of [h1, h2, h3]) {
    const dump = JSON.stringify(h.report());
    for (const leaked of ['zanzibar', 'premiums', 'Premium payment terms', 'Premium', 'agreement'])
      assert.ok(!dump.includes(leaked), leaked);
  }
});

test('PROVIDER CALL ACCOUNTING: providerCalls equals the scripted provider call count across accepted, rejected, cache, memoized and zero-item cases', async () => {
  const ZERO: KnowledgeExtractionOutput = { items: [], relationships: [] };
  const bad: KnowledgeExtractionOutput = {
    items: [{ id: 'i1', type: 'concept', statement: 'Quantum chromodynamics lattice', domain: 'x', confidence: 0.9 }],
    relationships: [],
  };
  const cache = new InMemoryCapabilityCache();
  const mk = (id: string) => unit({ id: id as ExperienceUnit['id'], content: `premiums ${id} are payable annually under this agreement.` });
  const { provider, extractor } = layerWith([GOOD, bad, ZERO], bounded(), cache);
  const hybrid = new HybridKnowledgeExtractor(extractor);
  await hybrid.extract(mk('ok')); //     generated, accepted
  await hybrid.extract(mk('bad')); //    generated, rejected by validation (still a provider call)
  await hybrid.extract(mk('zero')); //   generated, zero items (no node to carry provenance)
  await hybrid.extract(mk('ok')); //     memoized repeat: no call
  await hybrid.extract(mk('zero')); //   memoized zero-item repeat: no call
  assert.equal(provider.callLog.length, 3);
  assert.equal(hybrid.report().providerCalls, 3);
  assert.equal(hybrid.report().modelCallsAttempted, 3);
  assert.equal(hybrid.report().outcomes.memoized, 2);

  // A fresh extractor over the same cache replays everything (including the zero-item answer) with NO provider call and providerCalls 0.
  const replay = layerWith([], bounded(), cache);
  const h2 = new HybridKnowledgeExtractor(replay.extractor);
  for (const id of ['ok', 'bad', 'zero']) await h2.extract(mk(id));
  assert.equal(replay.provider.callLog.length, 0);
  assert.equal(h2.report().providerCalls, 0);
  assert.equal(h2.report().outcomes.cache_hit, 2, 'accepted and zero-item replays are cache hits');
  assert.equal(h2.report().outcomes.rejected_invalid, 1);
  assert.equal(h2.report().outcomes.accepted, undefined, 'a zero-item cache replay must not be mislabelled as a fresh accepted call');
});

test('AiKnowledgeExtractor sets modelCall provenance even for a zero-item answer', async () => {
  const { extractor } = layerWith([{ items: [], relationships: [] }]);
  const r = await extractor.extract(unit());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.nodes.length, 0);
  assert.deepEqual(r.value.modelCall, { source: 'generated', provider: 'anthropic', model: 'test-model' });
});

test('validateModelExtraction: each rule yields exactly its fixed code', () => {
  const u = unit();
  const ok = (over: Partial<CandidateKnowledgeNode>) =>
    validateModelExtraction(u, { nodes: [node({ localId: 'a', label: 'Premium payment', ...over })], edges: [] });
  assert.deepEqual(ok({}), []);
  assert.deepEqual(ok({ label: 'Premiums obligation' }), [], 'stem match tolerates an abstraction of the text');
  assert.ok(ok({ label: '   ' }).includes('empty_label'));
  assert.ok(ok({ label: 'x'.repeat(501) }).includes('label_too_long'));
  assert.ok(ok({ label: 'Premium\u0007payment' }).includes('control_chars'));
  assert.ok(ok({ confidence: 1.5 }).includes('confidence_out_of_range'));
  assert.ok(ok({ confidence: Number.NaN }).includes('confidence_out_of_range'));
  assert.ok(ok({ label: 'Zebra giraffe' }).includes('ungrounded_label'));
  assert.ok(
    validateModelExtraction(u, {
      nodes: [node({ localId: 'a', label: 'Premium' }), node({ localId: 'a', label: 'Premium' })],
      edges: [],
    }).includes('duplicate_local_id'),
  );
  const edge = (over: object) => ({
    type: 'references' as const,
    fromLocalId: 'a',
    toLocalId: 'a',
    confidence: 0.7,
    provenance: node({}).provenance,
    ...over,
  });
  const withEdge = (e: object) =>
    validateModelExtraction(u, { nodes: [node({ localId: 'a', label: 'Premium payment' })], edges: [edge(e)] });
  assert.deepEqual(withEdge({}), []);
  assert.deepEqual(withEdge({ toLocalId: 'ghost' }), ['dangling_edge']);
  assert.deepEqual(withEdge({ confidence: 2 }), ['edge_confidence_out_of_range']);
  for (const v of [...ok({ label: '   ' }), ...withEdge({ toLocalId: 'ghost' })])
    assert.ok((MODEL_REJECTION_CODES as readonly string[]).includes(v));
});

test('a unit is escalated at most ONCE per extractor: repeats are memoized with no second call', async () => {
  const { provider, extractor } = layerWith([GOOD, GOOD]);
  const hybrid = new HybridKnowledgeExtractor(extractor);
  const u = unit();
  await hybrid.extract(u);
  await hybrid.extract(u);
  await Promise.all([hybrid.extract(u), hybrid.extract(u)]);
  assert.equal(provider.callLog.length, 1);
  assert.equal(hybrid.report().modelCallsAttempted, 1);
  assert.equal(hybrid.report().outcomes.memoized, 3);
  assert.equal(hybrid.report().escalated, 4);
});

test('a provider failure is reported as "failed", distinct from a policy/budget "denied"', async () => {
  const layer = new AiCapabilityLayer({ providers: [], policy: { rules: [] }, inferenceScope: bounded() });
  const hybrid = new HybridKnowledgeExtractor(new AiKnowledgeExtractor(layer));
  const r = await hybrid.extract(unit());
  assert.ok(r.ok);
  assert.equal(hybrid.report().outcomes.failed, 1);
  assert.equal(hybrid.report().outcomes.denied, undefined);
});

test('PROVENANCE: rule, model-generated and cache-replayed candidates stay distinguishable', async () => {
  const cache = new InMemoryCapabilityCache();
  const first = layerWith([GOOD], bounded(), cache);
  const r1 = await new HybridKnowledgeExtractor(first.extractor).extract(unit());
  assert.ok(r1.ok);
  if (!r1.ok) return;
  const rule = r1.value.nodes.find((n) => n.isUnitPrimary)!;
  const generated = r1.value.nodes.find((n) => n.localId === 'i1')!;
  assert.equal(rule.extractorName, 'rule-based');
  assert.equal(rule.provenance.derivation, undefined, 'rule-derived candidates carry no model derivation');
  assert.equal(generated.extractorName, 'ai');
  assert.deepEqual(
    { ...generated.provenance.derivation },
    { kind: 'llm', source: 'generated', provider: 'anthropic', model: 'test-model', escalationReason: 'always' },
  );

  // A brand-new extractor over the same cache: no provider call, and the result says so.
  const second = layerWith([], bounded(), cache);
  const h2 = new HybridKnowledgeExtractor(second.extractor);
  const r2 = await h2.extract(unit());
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(second.provider.callLog.length, 0);
  assert.equal(r2.value.nodes.find((n) => n.localId === 'i1')?.provenance.derivation?.source, 'cache');
  assert.equal(h2.report().outcomes.cache_hit, 1);
});

test('without an AI extractor the hybrid is rule-only and reports nothing escalated', async () => {
  const hybrid = new HybridKnowledgeExtractor();
  const r = await hybrid.extract(unit());
  assert.ok(r.ok && r.value.nodes.every((n) => n.extractorName === 'rule-based'));
  assert.deepEqual(hybrid.report(), {
    unitsSeen: 0,
    escalated: 0,
    skipped: 0,
    byReason: {},
    outcomes: {},
    modelCallsAttempted: 0,
    providerCalls: 0,
    rejections: {},
    rejectedUnits: [],
    diagnostics: { ruleTiers: { no_candidate: 0, low_confidence: 0, strong: 0 }, unitsWithCompetingCandidates: 0 },
  });
});

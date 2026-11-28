import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { checkGrounding, createCapabilityLayer, parseTrees, stripUnknown, XoExecutor } from '@xo/capability-layer';
import { LEXICON, TREE } from './lexicon-fixture.js';
import { buildArms, buildGoldXo, FREIGHT_TREE, generateAbstentionTasks, generateEvalTasks, OUTPUT_CONTRACT } from '../src/index.js';

const CLAIM =
  'Acme reports damage to 2,140 lb of glass, delivered on March 3, 2026; the claim was filed on March 11, 2026. They have filed two earlier claims. Declared value is $14,300.';

test('grounding accepts supported facts and a derived day count', () => {
  const r = checkGrounding(
    TREE,
    { weight_lb: 2140, declared_value_usd: 14300, claimant_claims_last_90d: 2, days_to_file: 8 },
    {
      weight_lb: { quote: '2,140 lb of glass' },
      declared_value_usd: { quote: 'Declared value is $14,300' },
      claimant_claims_last_90d: { quote: 'two earlier claims' },
      days_to_file: { quote: ['delivered on March 3, 2026', 'filed on March 11, 2026'], derived: true },
    },
    CLAIM,
  );
  assert.deepEqual(r, { ok: true });
});

test('adversarial: invented value, missing evidence, fake quote, wrong number, empty quote are all refused', () => {
  const bad = checkGrounding(
    TREE,
    { damage_pct: 100, weight_lb: 2140, declared_value_usd: 99999, claimant_claims_last_90d: 0, days_to_file: 8 },
    {
      weight_lb: { quote: '2,140 lb of glass' },
      declared_value_usd: { quote: 'Declared value is $14,300' }, // real quote, wrong number
      claimant_claims_last_90d: { quote: 'no prior claims were filed' }, // not in the text
      days_to_file: { quote: '  ' },
      // damage_pct: no evidence at all
    },
    CLAIM,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const by = Object.fromEntries(bad.ungrounded.map((u) => [u.field, u.reason]));
    assert.equal(by['damage_pct'], 'no_evidence');
    assert.equal(by['declared_value_usd'], 'value_not_in_quote');
    assert.equal(by['claimant_claims_last_90d'], 'quote_not_in_text');
    assert.equal(by['days_to_file'], 'no_evidence');
    assert.equal(by['weight_lb'], undefined);
  }
});

test('adversarial (seen in the live abstain run): an invented value marked derived with an unrelated quote is refused', () => {
  const r = checkGrounding(
    TREE,
    { damage_pct: 100 },
    { damage_pct: { quote: 'Acme reports damage to 2,140 lb of glass', derived: true } },
    CLAIM,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.ungrounded[0]!.reason, 'value_not_in_quote');
});

test('a derived day count needs two quoted figures; one quote cannot launder an invented derivable value', () => {
  const one = checkGrounding(TREE, { days_to_file: 8 }, { days_to_file: { quote: 'filed on March 11, 2026', derived: true } }, CLAIM);
  assert.equal(one.ok, false);
  const two = checkGrounding(
    TREE,
    { days_to_file: 8 },
    { days_to_file: { quote: 'delivered on March 3, 2026 … filed on March 11, 2026', derived: true } },
    CLAIM,
  );
  assert.equal(two.ok, true);
});

test('classification enums need no quote, but a quote that is given must still be verbatim', () => {
  assert.equal(checkGrounding(TREE, { claim_type: 'damage' }, {}, CLAIM).ok, true);
  assert.equal(
    checkGrounding(TREE, { claim_type: 'damage' }, { claim_type: { quote: 'this is a damage claim' } }, CLAIM).ok,
    false,
  );
});

/** Scripted model: first call invents damage_pct with no evidence; after the tool refuses it escalates, as instructed. */
class Scripted implements ModelProvider {
  readonly id = 'scripted';
  toolResults: string[] = [];
  describeCapabilities() {
    return {
      providerId: this.id,
      models: ['s'],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: true,
      maxContextTokens: 1e6,
    };
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const last = [...req.messages].reverse().find((m) => m.role === 'tool');
    if (last === undefined)
      return {
        text: '',
        usage,
        modelUsed: 's',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'evaluate_decision_tree', input: { facts: { claim_type: 'damage', damage_pct: 100 } } }],
      };
    this.toolResults.push(last.content);
    return {
      text: JSON.stringify({ decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager', reason: 'missing' }),
      usage,
      modelUsed: 's',
      finishReason: 'stop',
    };
  }
}

for (const requireEvidence of [false, true]) {
  test(`executor with requireEvidence=${requireEvidence}: invented fact ${requireEvidence ? 'is refused' : 'reaches the tree (old behaviour)'}`, async () => {
    const layer = createCapabilityLayer(buildGoldXo(), { host: { family: 'claude', capabilities: ['chat', 'tool_use'] }, requireEvidence, ...(requireEvidence ? {} : { groundingWaiver: { reason: 'test of the ungrounded behaviour' } }) });
    const model = new Scripted();
    const ex = new XoExecutor(layer, { provider: model, model: 's', preamble: OUTPUT_CONTRACT, cache: false });
    const [t] = generateAbstentionTasks(31337, 'standard', 1);
    const res = await ex.execute({ text: t!.narrative });
    const tool = res.toolCalls[0]!;
    if (requireEvidence) {
      assert.equal(tool.isError, true);
      assert.match(tool.result, /UNGROUNDED_FACTS/);
      assert.match(tool.result, /damage_pct/);
    } else assert.doesNotMatch(tool.result, /UNGROUNDED_FACTS/);
    assert.ok(layer.requiresEvidence === requireEvidence);
  });
}

test('tool definition only advertises evidence when required', () => {
  const host = { family: 'claude', capabilities: ['chat', 'tool_use'] } as const;
  const off = createCapabilityLayer(buildGoldXo(), { host, requireEvidence: false, groundingWaiver: { reason: 'test of the ungrounded behaviour' } })
    .toolDefinitions()
    .find((d) => d.name === 'evaluate_decision_tree')!;
  const on = createCapabilityLayer(buildGoldXo(), { host, requireEvidence: true })
    .toolDefinitions()
    .find((d) => d.name === 'evaluate_decision_tree')!;
  assert.equal('evidence' in (off.inputSchema as { properties: object }).properties, false);
  assert.equal('evidence' in (on.inputSchema as { properties: object }).properties, true);
  assert.ok(parseTrees([FREIGHT_TREE]) !== null);
  assert.ok(generateEvalTasks().length === 50);
});

test('zero cannot be asserted with an unrelated real quote (the "0 if none" default); a quote that says "none" is accepted', () => {
  const unrelated = checkGrounding(
    TREE,
    { claimant_claims_last_90d: 0 },
    { claimant_claims_last_90d: { quote: 'Acme reports damage to 2,140 lb of glass' } },
    CLAIM,
  );
  assert.equal(unrelated.ok, false);
  if (!unrelated.ok) assert.ok(['value_not_in_quote', 'quote_off_topic'].includes(unrelated.ungrounded[0]!.reason)); // off topic by the vocabulary, or a zero with no absence statement
  const stated = checkGrounding(
    TREE,
    { claimant_claims_last_90d: 0 },
    { claimant_claims_last_90d: { quote: 'has not filed any other claims with us' } },
    'Acme has not filed any other claims with us in the past 90 days.',
  );
  assert.deepEqual(stated, { ok: true });
});

test('stripUnknown: explicit unknown status, "unknown" text and null are removed, but 0 and false are kept as values', () => {
  const r = stripUnknown(
    { damage_pct: 50, weight_lb: 'unknown', salvage_value_usd: 0, weather_event: false, declared_value_usd: null, packaging: 'carrier_packed' },
    { damage_pct: { status: 'unknown' } },
  );
  assert.deepEqual([...r.unknown].sort(), ['damage_pct', 'declared_value_usd', 'weight_lb']);
  assert.deepEqual(r.facts, { salvage_value_usd: 0, weather_event: false, packaging: 'carrier_packed' });
});

/** Scripted model that reports a needed fact as unknown (explicit status) instead of inventing it. */
class UnknownReporter extends Scripted {
  override async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const last = [...req.messages].reverse().find((m) => m.role === 'tool');
    if (last !== undefined) return super.complete(req);
    return {
      text: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      modelUsed: 's',
      finishReason: 'tool_use',
      toolCalls: [
        {
          id: 'c1',
          name: 'evaluate_decision_tree',
          input: {
            facts: { claim_type: 'damage', damage_pct: 'unknown' },
            evidence: { damage_pct: { status: 'unknown' } },
          },
        },
      ],
    };
  }
}

test('executor: a fact reported unknown never reaches the tree as a value, so the tree answers missing_facts', async () => {
  const layer = createCapabilityLayer(buildGoldXo(), { host: { family: 'claude', capabilities: ['chat', 'tool_use'] }, requireEvidence: true });
  const model = new UnknownReporter();
  const ex = new XoExecutor(layer, { provider: model, model: 's', preamble: OUTPUT_CONTRACT, cache: false });
  const [t] = generateAbstentionTasks(31337, 'standard', 1);
  const res = await ex.execute({ text: t!.narrative });
  const tool = res.toolCalls[0]!;
  assert.doesNotMatch(tool.result, /UNGROUNDED_FACTS/);
  assert.doesNotMatch(tool.result, /"decision":"(approve|partial)"/);
  assert.match(tool.result, /missing/);
});

test('a quote that is the whole claim text is refused (it would make every zero and number look supported)', () => {
  const text = 'x'.repeat(30) + ' no damage noted. ' + 'y'.repeat(260);
  const r = checkGrounding(TREE, { claimant_claims_last_90d: 0 }, { claimant_claims_last_90d: { quote: text } }, text);
  assert.equal(r.ok, false);
});

test('a zero quoted from an unrelated absence ("no damage noted") is refused; one about prior claims is accepted', () => {
  const text = 'Acme reports damage. The proof of delivery was signed clean, with no damage noted. First contact from this customer this quarter.';
  const bad = checkGrounding(TREE, { claimant_claims_last_90d: 0 }, { claimant_claims_last_90d: { quote: 'with no damage noted' } }, text);
  assert.equal(bad.ok, false);
  const good = checkGrounding(TREE, { claimant_claims_last_90d: 0 }, { claimant_claims_last_90d: { quote: 'First contact from this customer this quarter' } }, text);
  assert.deepEqual(good, { ok: true });
});

/** Model that never makes a valid tool call, then answers "approve" on its own. */
class Rogue extends Scripted {
  override async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    if ([...req.messages].some((m) => m.role === 'tool'))
      return { text: JSON.stringify({ decision: 'partial', payout_usd: 999, escalation_target: null, reason: 'my own maths' }), usage, modelUsed: 's', finishReason: 'stop' };
    return {
      text: '',
      usage,
      modelUsed: 's',
      finishReason: 'tool_use',
      toolCalls: [{ id: 'c1', name: 'evaluate_decision_tree', input: { tree_id: 'claim_adjudication', facts: '{claim_type: "damage"}', evidence: '{}' } }],
    };
  }
}

test('decision commit: if no tree evaluation ever succeeded the grounded arm escalates, whatever the model says afterwards', async () => {
  const arms = buildArms({ provider: new Rogue(), model: 's', gold: buildGoldXo(), lexicon: LEXICON });
  const [t] = generateAbstentionTasks(31337, 'standard', 1);
  const run = await arms.xo_tools_grounded.run(t!);
  assert.equal(run.output?.decision, 'escalate');
  assert.equal(run.output?.escalation_target, 'Claims Manager');
  assert.equal(run.overridden, true);
  assert.match(run.toolCalls[0]!.result, /INVALID_INPUT/);
});

test('evidence cues: a real quote that is not about the field is refused, even when it contains the number', () => {
  const text = 'BOL lists $3,100 as the stated worth. They are asking for $3,100. Customer palletised it themselves; the wrap looked proper.';
  const f = (quote: string, field = 'declared_value_usd', value: unknown = 3100) => checkGrounding(TREE, { [field]: value }, { [field]: { quote } }, text);
  assert.equal(f('They are asking for $3,100').ok, false); // the claimed amount is not the declared value
  assert.equal(f('$3,100').ok, false); // a bare number cannot be attributed to a field
  assert.deepEqual(f('BOL lists $3,100 as the stated worth'), { ok: true });
  assert.equal(f('BOL lists $3,100 as the stated worth', 'full_value_coverage', false).ok, false); // wrong topic for a boolean
  assert.deepEqual(f('Customer palletised it themselves; the wrap looked proper', 'packaging', 'shipper_adequate'), { ok: true });
});

// ── cue recall: real-world phrasings that were NOT used to write the cue lists must still ground (a cue miss = false escalation) ──
const REAL_WORLD: ReadonlyArray<readonly [string, unknown, string]> = [
  ['weather_event', true, 'A storm closed the pass near Denver.'],
  ['weather_event', true, 'Heavy rain and a road closure held the truck.'],
  ['weather_event', true, 'Hurricane warning in effect at the port.'],
  ['weather_event', false, 'Driver called out and the terminal was short staffed.'],
  ['weather_event', false, 'Truck had a mechanical breakdown at the origin.'],
  ['pod_damage_noted', true, 'Damage was noted on the COD receipt.'],
  ['pod_damage_noted', true, 'Recipient signed for it with exceptions.'],
  ['pod_damage_noted', false, 'Delivery ticket signed clean.'],
  ['packaging', 'shipper_inadequate', 'Boxed in thin cartons with no padding on a bare skid.'],
  ['packaging', 'carrier_packed', 'Our dock crew crated it before pickup.'],
  ['full_value_coverage', true, 'An FVC endorsement was purchased with the booking.'],
  ['full_value_coverage', false, 'No additional coverage was bought.'],
  ['declared_value_usd', 12000, 'Declared value on the BOL: $12,000.'],
  ['declared_value_usd', 5000, 'Commercial invoice value is $5,000.'],
  ['salvage_value_usd', 800, 'A scrap yard offered $800 for the remains.'],
  ['salvage_value_usd', 1500, 'Resale of what is left would bring $1,500.'],
];
for (const [field, value, sentence] of REAL_WORLD) {
  test(`cue recall: ${field}=${String(value)} grounds on "${sentence}"`, () => {
    const text = `Acme Freight claim. ${sentence} Filing details follow.`;
    const r = checkGrounding(TREE, { [field]: value }, { [field]: { quote: sentence.replace(/\.$/, '') } }, text);
    assert.deepEqual(r, { ok: true });
  });
}

test('cue precision: off-topic real clauses stay refused (word-start matching, no substring accidents)', () => {
  const text = 'They train drivers at the office. A notice was posted. They are asking for $1,290. Wants $4,300 back. Pay by window.';
  const f = (field: string, value: unknown, quote: string) => checkGrounding(TREE, { [field]: value }, { [field]: { quote } }, text);
  assert.equal(f('weather_event', false, 'They train drivers at the office').ok, false); // "train" is not "rain"
  assert.equal(f('weather_event', false, 'A notice was posted').ok, false); // "notice" is not "ice"
  assert.equal(f('declared_value_usd', 1290, 'They are asking for $1,290').ok, false);
  assert.equal(f('salvage_value_usd', 4300, 'Wants $4,300 back').ok, false);
  assert.equal(f('packaging', 'carrier_packed', 'Pay by window').ok, false);
});

test('conflicting status withholds the fact like unknown (the tree then asks for it and the case escalates)', () => {
  const r = stripUnknown({ full_value_coverage: true, damage_pct: 40 }, { full_value_coverage: { status: 'conflicting' } });
  assert.deepEqual(r.unknown, ['full_value_coverage']);
  assert.deepEqual(r.facts, { damage_pct: 40 });
});

test('empty evidence on a fixed-label classification is not a refusal; a non-verbatim quote on one still is', () => {
  const text = 'Acme reports damage to the glass shipment.';
  assert.deepEqual(checkGrounding(TREE, { claim_type: 'damage' }, { claim_type: { quote: '' } }, text), { ok: true });
  assert.deepEqual(checkGrounding(TREE, { claim_type: 'damage' }, {}, text), { ok: true });
  assert.equal(checkGrounding(TREE, { claim_type: 'damage' }, { claim_type: { quote: 'nothing like the text' } }, text).ok, false);
});

// ── derivation: recomputed from the evidence, never trusted ──
test('derivation: a wrong day count is refused even with two real dates; the right one passes', () => {
  const q = { days_to_file: { quote: ['delivered on March 3, 2026', 'filed on March 11, 2026'], derived: true } };
  assert.equal(checkGrounding(TREE, { days_to_file: 5 }, q, CLAIM).ok, false);
  assert.equal(checkGrounding(TREE, { days_to_file: 8 }, q, CLAIM).ok, true);
});

test('derivation: dates without a year, three dates, or two unrelated numbers can no longer launder a derived value', () => {
  const noYear = 'Acme: delivered on March 3; filed on March 11.';
  assert.equal(checkGrounding(TREE, { days_to_file: 8 }, { days_to_file: { quote: ['delivered on March 3', 'filed on March 11'], derived: true } }, noYear).ok, false);
  const three = 'Delivered on March 3, 2026, filed on March 11, 2026, reviewed on April 1, 2026.';
  assert.equal(checkGrounding(TREE, { days_to_file: 8 }, { days_to_file: { quote: three, derived: true } }, three).ok, false);
  const figures = 'They filed 2 earlier claims and lost 14 hours.';
  assert.equal(checkGrounding(TREE, { days_to_file: 16 }, { days_to_file: { quote: figures, derived: true } }, figures).ok, false);
});

test('derivation: a derivable input with no declared derivation gets no leniency (the value must be in the quote)', () => {
  const tree = { ...TREE, inputs: TREE.inputs.map((i) => (i.name === 'days_to_file' ? { ...i, derivation: undefined } : i)) };
  assert.equal(checkGrounding(tree, { days_to_file: 8 }, { days_to_file: { quote: ['delivered on March 3, 2026', 'filed on March 11, 2026'], derived: true } }, CLAIM).ok, false);
});

// ── typed evidence: entailment and contradiction detection, by the runtime ──
test('typed evidence: a real quote that says the opposite is refused; a self-contradicting case is refused whatever the model says', () => {
  const text = 'The proof of delivery was signed clean, with no damage noted. The consignee noted the damage on the proof of delivery at the time of delivery.';
  const f = (value: boolean, quote: string) => checkGrounding(TREE, { pod_damage_noted: value }, { pod_damage_noted: { quote } }, text);
  const t = f(true, 'The consignee noted the damage on the proof of delivery');
  assert.equal(t.ok, false);
  if (!t.ok) assert.equal(t.ungrounded[0]!.reason, 'conflicting_evidence');
  const fl = f(false, 'The proof of delivery was signed clean, with no damage noted');
  assert.equal(fl.ok, false);
  if (!fl.ok) assert.equal(fl.ungrounded[0]!.reason, 'conflicting_evidence');
});

test('typed evidence: the supplied value must be said somewhere in the text; a misread quote is refused', () => {
  const text = 'There is no Full Value Coverage endorsement on the shipment.';
  const wrong = checkGrounding(TREE, { full_value_coverage: true }, { full_value_coverage: { quote: 'There is no Full Value Coverage endorsement on the shipment' } }, text);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.ungrounded[0]!.reason, 'quote_does_not_support_value');
  assert.equal(checkGrounding(TREE, { full_value_coverage: false }, { full_value_coverage: { quote: 'There is no Full Value Coverage endorsement' } }, text).ok, true);
  // nothing in the text states it at all: an enum with no quote at all is no longer free
  const none = checkGrounding(TREE, { packaging: 'shipper_adequate' }, {}, 'Acme reports damage to a pallet of glass.');
  assert.equal(none.ok, false);
});

// ── policy: the package's declared requirement and the operator's choice ──
const HOST = { family: 'claude' as const, capabilities: ['chat', 'tool_use'] as ('chat' | 'tool_use')[] };

test('policy: a package that declares grounding required is grounded by default; opting out needs a recorded waiver', () => {
  const l = createCapabilityLayer(buildGoldXo(), { host: HOST, evidenceLexicon: LEXICON });
  assert.equal(l.requiresEvidence, true);
  assert.equal(l.emitLoadReceipt().grounding.source, 'package');
  assert.throws(() => createCapabilityLayer(buildGoldXo(), { host: HOST, requireEvidence: false }), /groundingWaiver/);
  assert.throws(() => createCapabilityLayer(buildGoldXo(), { host: HOST, requireEvidence: false, groundingWaiver: { reason: '  ' } }), /groundingWaiver/);
  const waived = createCapabilityLayer(buildGoldXo(), { host: HOST, requireEvidence: false, groundingWaiver: { reason: 'offline benchmark', approvedBy: 'akira' } });
  assert.equal(waived.requiresEvidence, false);
  const r = waived.emitLoadReceipt().grounding;
  assert.equal(r.source, 'waived');
  assert.equal(r.waiver?.reason, 'offline benchmark');
});

test('policy: the receipt says what is and is not verified, and the compiled tree declares grounding too', () => {
  const g = createCapabilityLayer(buildGoldXo(), { host: HOST, trustedFactSources: ['intake_form'], evidenceLexicon: LEXICON }).emitLoadReceipt().grounding;
  assert.ok(g.typedEvidence.includes('pod_damage_noted') && g.typedEvidence.includes('packaging'));
  assert.ok(g.recomputed.includes('days_to_file'));
  assert.ok(g.unverifiedValue.includes('claim_type'));
  assert.deepEqual(g.trustedFactSources, ['intake_form']);
});

// ── structured inputs: the direct path is held to the same standard ──
test('structured facts: no provenance, an untrusted source, or a bad document span are withheld before the tree runs', async () => {
  const gold = buildGoldXo();
  const layer = createCapabilityLayer(gold, { host: HOST, trustedFactSources: ['intake_form'], evidenceLexicon: LEXICON });
  const treesJson: unknown = JSON.parse(new TextDecoder().decode(gold.components.find((c) => c.kind === 'decision_trees')!.data));
  const ex = new XoExecutor(layer, { preamble: OUTPUT_CONTRACT, cache: false }, treesJson);
  const t = generateEvalTasks(5, 'standard').find((x) => x.stratum === 'DAMAGE_PARTIAL'); // damage_pct decides this claim
  const facts = t!.statedFacts as Record<string, unknown>;
  assert.ok('damage_pct' in facts);
  const form = Object.fromEntries(Object.keys(facts).map((k) => [k, { kind: 'form_field' as const, source: 'intake_form' }]));
  const ok = await ex.execute({ text: t!.narrative, facts, provenance: form });
  assert.equal(ok.path, 'deterministic');
  const none = await ex.execute({ text: t!.narrative, facts });
  assert.notEqual(none.path, 'deterministic');
  assert.ok((none.rejectedFacts?.length ?? 0) > 0 || none.path === 'refused');
  const evil = Object.fromEntries(Object.keys(facts).map((k) => [k, { kind: 'form_field' as const, source: 'random_webhook' }]));
  assert.notEqual((await ex.execute({ text: t!.narrative, facts, provenance: evil })).path, 'deterministic');
  const spanLie = { ...form, damage_pct: { kind: 'document_span' as const, source: 'claim_text', quote: 'about ninety percent was crushed' } };
  assert.notEqual((await ex.execute({ text: t!.narrative, facts, provenance: spanLie })).path, 'deterministic');
});

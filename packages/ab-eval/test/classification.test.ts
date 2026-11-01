import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { applyClassifications, createCapabilityLayer, lookupClassification, XoExecutor } from '@xo/capability-layer';
import { extractClassificationDefinitions, segmentPolicyText } from '@xo/compiler';
import {
  buildGoldXo,
  compileManual,
  FREIGHT_CLASSIFICATION,
  FREIGHT_GLOSSARY_INPUT,
  FREIGHT_TREE,
  generateEvalTasks,
  OUTPUT_CONTRACT,
  scoreClassification,
  withClassification,
  type FreightTask,
} from '../src/index.js';

/** Seeds not used for any measurement or tuning so far (31337, 4242, 7, 9001 are off limits). */
const FRESH = [1234, 2468, 8080, 13579, 777777];

/** A model that always calls the tool once with the given facts, then answers from the tool's outcome. */
class OneCall implements ModelProvider {
  readonly id = 'one-call';
  last = '';
  constructor(private readonly facts: Record<string, unknown>) {}
  describeCapabilities() {
    return {
      providerId: this.id,
      models: ['m'],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: true,
      maxContextTokens: 1e6,
    };
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const tool = [...req.messages].reverse().find((m) => m.role === 'tool');
    if (tool === undefined)
      return {
        text: '',
        usage,
        modelUsed: 'm',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c', name: 'evaluate_decision_tree', input: { facts: this.facts } }],
      };
    this.last = tool.content;
    return {
      text: '{"decision":"deny","payout_usd":0,"escalation_target":null,"reason":"x"}',
      usage,
      modelUsed: 'm',
      finishReason: 'stop',
    };
  }
}

async function run(task: FreightTask, narrative: string, modelClass: string | undefined) {
  const layer = createCapabilityLayer(buildGoldXo({ classification: true }), {
    host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
  });
  const facts: Record<string, unknown> = { ...task.statedFacts };
  if (modelClass === undefined) delete facts['commodity_class'];
  else facts['commodity_class'] = modelClass;
  const model = new OneCall(facts);
  const ex = new XoExecutor(layer, { provider: model, model: 'm', preamble: OUTPUT_CONTRACT, cache: false });
  const res = await ex.execute({ text: narrative });
  return JSON.parse(res.toolCalls[0]!.result) as {
    outcome: { decision: string; escalation_target: string | null; reason_code: string; payout_usd: number };
    trace: string[];
    classification: { status: string; modelValue: unknown; lookupValues: string[] }[];
    model_assisted_fields?: string[];
  };
}

const pickTask = (stratum: string, notClass?: string): FreightTask =>
  FRESH.flatMap((s) => generateEvalTasks(s, 'variant')).find((t) => t.stratum === stratum && t.facts.commodity_class !== notClass)!;

describe('glossary lookup against claims on fresh seeds (offline, no model)', () => {
  for (const style of ['standard', 'variant'] as const)
    it(`${style} phrasing: never calls a non-hazmat claim hazmat, finds every hazmat claim, never ambiguous`, () => {
      const bundle = buildGoldXo({ classification: true });
      for (const seed of FRESH) {
        const s = scoreClassification(bundle, generateEvalTasks(seed, style))!;
        assert.equal(s.falseHazmat, 0, `seed ${seed}`);
        assert.ok(s.hazmatRecall === null || s.hazmatRecall === 1, `seed ${seed}`);
        assert.equal(s.ambiguous, 0, `seed ${seed}`);
        assert.equal(s.correctWhenMatched, s.matched, `seed ${seed}`);
        assert.ok(s.matched / s.tasks >= 0.95, `seed ${seed}: coverage ${s.matched}/${s.tasks}`);
      }
    });
  it('claimant names and claim boilerplate never match a glossary term', () => {
    for (const name of [
      'Brightwater Supply',
      'Okafor & Daughters',
      'Lindqvist Outfitters',
      'Pacific Rim Traders',
      'Marlow Hardware',
      'Tanaka Imports',
      'Delacroix Foods',
      'Ridgeline Tech',
      'Corvus Labs',
      'Hollis Distribution',
    ])
      assert.deepEqual(
        lookupClassification(
          FREIGHT_CLASSIFICATION,
          `${name}, file 12345: cold-chain complaint, refrigeration unit ran warm, delivered, customer wrote`,
        ).values,
        [],
        name,
      );
  });
});

describe('reconciling the model’s class with the glossary (the recurring seed-9001 failures)', () => {
  it('lithium batteries the model called "general": hazmat applies, tree escalates to Hazmat Compliance, both values in the trace', async () => {
    const t = pickTask('HAZMAT');
    const r = await run(t, t.narrative, 'general');
    assert.equal(r.outcome.decision, 'escalate');
    assert.equal(r.outcome.escalation_target, 'Hazmat Compliance');
    assert.equal(r.classification[0]!.status, 'high_risk');
    assert.equal(r.classification[0]!.modelValue, 'general');
    assert.match(r.trace.join(' '), /high-risk "hazmat".*but the model said "general"/);
  });
  it('model left commodity_class out on a hazmat claim: the glossary supplies it', async () => {
    const t = pickTask('HAZMAT');
    const r = await run(t, t.narrative, undefined);
    assert.equal(r.outcome.escalation_target, 'Hazmat Compliance');
  });
  it('dry goods the model called perishable: conflict, escalated to the Claims Manager with both values, nothing paid', async () => {
    const t = pickTask('TEMP_NOT_SENSITIVE');
    const r = await run(t, t.narrative, 'perishable');
    assert.equal(r.outcome.decision, 'escalate');
    assert.equal(r.outcome.escalation_target, 'Claims Manager');
    assert.equal(r.outcome.reason_code, 'CLASSIFICATION_CONFLICT');
    assert.equal(r.outcome.payout_usd, 0);
    assert.match(r.trace.join(' '), /model said "perishable" but the glossary says/);
  });
  it('agreement leaves the tree’s own outcome untouched and escalates nothing', async () => {
    const t = pickTask('TEMP_NOT_SENSITIVE');
    const r = await run(t, t.narrative, String(t.facts.commodity_class));
    assert.equal(r.outcome.decision, t.expected.decision);
    assert.equal(r.classification[0]!.status, 'agree');
  });
  it('goods the glossary does not know: falls back to the model, flagged model-assisted', async () => {
    const t = pickTask('DAMAGE_PARTIAL', 'hazmat');
    const term = lookupClassification(FREIGHT_CLASSIFICATION, t.narrative).matches[0]!.term;
    const narrative = t.narrative.replace(new RegExp(term.replace(/\s+/g, '[\\s-]+') + '(?:s|es)?', 'i'), 'insulin vials');
    assert.deepEqual(lookupClassification(FREIGHT_CLASSIFICATION, narrative).values, []);
    const r = await run(t, narrative, String(t.facts.commodity_class));
    assert.equal(r.classification[0]!.status, 'unknown');
    assert.deepEqual(r.model_assisted_fields, ['commodity_class']);
  });
  it('text that matches two classes ("frozen glass"): escalated, never guessed', async () => {
    const t = pickTask('DAMAGE_PARTIAL', 'hazmat');
    const term = lookupClassification(FREIGHT_CLASSIFICATION, t.narrative).matches[0]!.term;
    const narrative = t.narrative.replace(new RegExp(term.replace(/\s+/g, '[\\s-]+') + '(?:s|es)?', 'i'), 'frozen glass panels');
    const r = await run(t, narrative, String(t.facts.commodity_class));
    assert.equal(r.outcome.escalation_target, 'Claims Manager');
    assert.equal(r.classification[0]!.status, 'conflict');
  });
  it('a model that is MORE cautious than the glossary is kept (hazmat stays hazmat)', () => {
    const tree = withClassification(FREIGHT_TREE);
    const r = applyClassifications(tree, { commodity_class: 'hazmat' }, 'steel fittings');
    assert.equal(r.escalation, undefined);
    assert.equal(r.facts['commodity_class'], 'hazmat');
  });
  it('a declared label the tree does not know cannot slip through', () => {
    const tree = withClassification(FREIGHT_TREE);
    const odd = { ...tree, inputs: tree.inputs.map((i) => (i.name === 'commodity_class' ? { ...i, enum: ['general'] } : i)) };
    const r = applyClassifications(odd, { commodity_class: 'general' }, 'lithium batteries');
    assert.equal(r.facts['commodity_class'], 'hazmat'); // high-risk applied; the tree’s own validation then rejects an undeclared label
  });
});

describe('compiler: what the document defines vs what the operator supplies', () => {
  const doc = segmentPolicyText(
    [
      '# Freight classes',
      '',
      'Hazmat freight includes lithium batteries, aerosols and pool chemicals. Frozen seafood and dairy products are perishable freight.',
    ].join('\n'),
  );
  it('extracts only definitional sentences and keeps the source sentence as evidence', () => {
    const defs = extractClassificationDefinitions(doc, ['hazmat', 'perishable', 'general']);
    assert.deepEqual(
      defs
        .filter((d) => d.value === 'hazmat')
        .map((d) => d.term)
        .sort(),
      ['aerosols', 'lithium batteries', 'pool chemicals'],
    );
    assert.deepEqual(
      defs
        .filter((d) => d.value === 'perishable')
        .map((d) => d.term.toLowerCase())
        .sort(),
      ['dairy products', 'frozen seafood'],
    );
    assert.ok(defs.every((d) => d.origin === 'manual' && (d.evidence ?? '').length > 20));
    assert.equal(defs.filter((d) => d.value === 'general').length, 0);
  });
  it('the Halvorsen manual defines NO goods for any class; without a glossary every class stays model-only and no lookup is attached', async () => {
    const { policy, bundle } = await compileManual();
    const rep = policy!.review.classification!;
    assert.deepEqual(rep.definedByManual, {});
    assert.deepEqual([...rep.uncovered].sort(), [...rep.classesInTree].sort());
    assert.ok(rep.classesInTree.includes('hazmat'));
    assert.equal(scoreClassification(bundle, generateEvalTasks(1234)), null);
  });
  it('with the operator glossary every class is covered, tagged operator, and the compiled bundle classifies the fresh-seed claims', async () => {
    const { policy, bundle } = await compileManual({ glossary: FREIGHT_GLOSSARY_INPUT });
    const rep = policy!.review.classification!;
    assert.deepEqual(rep.uncovered, []);
    assert.ok(rep.operatorSupplied > 20);
    assert.deepEqual(rep.highRisk, ['hazmat']);
    assert.equal(rep.onConflict.target, 'Claims Manager');
    for (const seed of FRESH) {
      const s = scoreClassification(bundle, generateEvalTasks(seed, 'variant'))!;
      assert.equal(s.falseHazmat, 0);
      assert.ok(s.hazmatRecall === null || s.hazmatRecall === 1);
    }
  });
});

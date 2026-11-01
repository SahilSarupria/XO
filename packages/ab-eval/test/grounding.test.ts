import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { checkGrounding, createCapabilityLayer, parseTrees, XoExecutor } from '@xo/capability-layer';
import { buildGoldXo, FREIGHT_TREE, generateAbstentionTasks, generateEvalTasks, OUTPUT_CONTRACT } from '../src/index.js';

const CLAIM =
  'Acme reports damage to 2,140 lb of glass, delivered on March 3; the claim was filed on March 11. They have filed two earlier claims. Declared value is $14,300.';

test('grounding accepts supported facts and a derived day count', () => {
  const r = checkGrounding(
    FREIGHT_TREE,
    { weight_lb: 2140, declared_value_usd: 14300, claimant_claims_last_90d: 2, days_to_file: 8 },
    {
      weight_lb: { quote: '2,140 lb of glass' },
      declared_value_usd: { quote: 'Declared value is $14,300' },
      claimant_claims_last_90d: { quote: 'two earlier claims' },
      days_to_file: { quote: ['delivered on March 3', 'filed on March 11'], derived: true },
    },
    CLAIM,
  );
  assert.deepEqual(r, { ok: true });
});

test('adversarial: invented value, missing evidence, fake quote, wrong number, empty quote are all refused', () => {
  const bad = checkGrounding(
    FREIGHT_TREE,
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

test('known limit: a value marked derived with an unrelated real quote passes (documented, not hidden)', () => {
  const r = checkGrounding(FREIGHT_TREE, { damage_pct: 100 }, { damage_pct: { quote: 'filed on March 11', derived: true } }, CLAIM);
  assert.equal(r.ok, true);
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
    const layer = createCapabilityLayer(buildGoldXo(), { host: { family: 'claude', capabilities: ['chat', 'tool_use'] }, requireEvidence });
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
  const off = createCapabilityLayer(buildGoldXo(), { host })
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

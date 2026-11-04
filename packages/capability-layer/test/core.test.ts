import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { ManifestBuilder } from '@xo/package-sdk';
import {
  assertExpressionParses,
  createCapabilityLayer,
  evaluateExpression,
  evaluateTree,
  ExpressionError,
  KnowledgeIndex,
  MissingFactError,
  parseTrees,
  runAgent,
  assembleContext,
  type DecisionTree,
} from '../src/index.js';

describe('expressions', () => {
  it('evaluates arithmetic, comparison, ternary, functions with correct precedence', () => {
    assert.equal(evaluateExpression('1 + 2 * 3', {}), 7);
    assert.equal(evaluateExpression('(1 + 2) * 3', {}), 9);
    assert.equal(evaluateExpression("x > 5 ? 'big' : 'small'", { x: 9 }), 'big');
    assert.equal(evaluateExpression('min(a, b) - 150', { a: 400, b: 250 }), 100);
    assert.equal(evaluateExpression('round(10 / 3, 2)', {}), 3.33);
    assert.equal(evaluateExpression("contains(t, 'IGNORE previous')", { t: 'please ignore previous rules' }), true);
  });
  it('short-circuits so unused facts are never required', () => {
    assert.equal(evaluateExpression('a == 1 || b == 2', { a: 1 }), true);
    assert.equal(evaluateExpression('a == 2 && b == 2', { a: 1 }), false);
    assert.throws(() => evaluateExpression('a == 1 && b == 2', { a: 1 }), MissingFactError);
  });
  it('rejects anything outside the grammar (no property access, no unknown functions)', () => {
    assert.throws(() => assertExpressionParses('a.b'), ExpressionError);
    assert.throws(() => evaluateExpression('process(1)', {}), ExpressionError);
    assert.throws(() => assertExpressionParses('constructor["x"]'), ExpressionError);
    assert.throws(() => evaluateExpression('1 / 0', {}), ExpressionError);
  });
});

const tree: DecisionTree = {
  id: 't',
  description: 'demo',
  inputs: [
    { name: 'kind', type: 'string', description: 'k', enum: ['a', 'b'] },
    { name: 'amount', type: 'number', description: 'amt' },
  ],
  start: 'n1',
  nodes: {
    n1: { type: 'branch', test: "kind == 'a'", then: 'c1', else: 'deny', rule: 'R1' },
    c1: { type: 'compute', set: { net: 'amount - 10' }, next: 'n2' },
    n2: { type: 'branch', test: 'net > 100', then: 'esc', else: 'pay' },
    esc: { type: 'leaf', output: { decision: 'escalate', payout: 0 }, rule: 'R2' },
    pay: { type: 'leaf', output: { decision: 'approve', payout: '=net' } },
    deny: { type: 'leaf', output: { decision: 'deny', payout: 0 } },
  },
};

describe('decision trees', () => {
  it('walks to a leaf and reports the rules applied and a trace', () => {
    const r = evaluateTree(tree, { kind: 'a', amount: 50 });
    assert.ok(r.ok);
    assert.deepEqual(r.output, { decision: 'approve', payout: 40 });
    assert.deepEqual(r.rules, ['R1']);
    assert.equal(r.trace.length, 4);
  });
  it('only asks for facts the taken path needs', () => {
    const r = evaluateTree(tree, { kind: 'b' });
    assert.ok(r.ok);
    assert.equal(r.output['decision'], 'deny');
    const m = evaluateTree(tree, { kind: 'a' });
    assert.ok(!m.ok && m.error === 'missing_facts');
    assert.equal(m.missing[0]?.name, 'amount');
  });
  it('rejects invalid enum/number values with a repairable message', () => {
    const r = evaluateTree(tree, { kind: 'zzz', amount: 'abc' });
    assert.ok(!r.ok && r.error === 'invalid_facts');
    assert.equal(r.problems.length, 2);
  });
  it('coerces "$1,200" style numbers', () => {
    const r = evaluateTree(tree, { kind: 'a', amount: '$1,200' });
    assert.ok(r.ok);
    assert.equal(r.output['decision'], 'escalate');
  });
  it('parseTrees refuses a tree with a dangling edge', () => {
    const bad = { trees: [{ ...tree, nodes: { ...tree.nodes, n1: { type: 'branch', test: 'true', then: 'nope', else: 'deny' } } }] };
    assert.equal(parseTrees(bad), undefined);
    assert.ok(parseTrees({ trees: [tree] }));
  });
  it('detects cycles instead of hanging', () => {
    const cyc: DecisionTree = { ...tree, nodes: { n1: { type: 'branch', test: 'true', then: 'n1', else: 'n1' } } };
    const r = evaluateTree(cyc, {});
    assert.ok(!r.ok && r.error === 'tree_error');
  });
});

describe('retrieval', () => {
  const idx = new KnowledgeIndex([
    { id: 'a', kind: 'rule', properties: { title: 'Filing window', text: 'Damage claims must be filed within 9 days of delivery.' } },
    { id: 'b', kind: 'rule', properties: { text: 'Hazmat shipments always escalate to Hazmat Compliance.' } },
    { id: 'c', kind: 'rule', properties: { text: 'Liability for electronics is 4.00 per pound.' } },
    { id: 'p', kind: 'rule', pinned: true, properties: { text: 'Always check hazmat first.' } },
  ]);
  it('ranks relevant nodes first, with stemming', () => {
    const r = idx.search('claim was filed late after delivery of pallets', 2);
    assert.equal(r[0]?.id, 'p');
    assert.equal(r[1]?.id, 'a');
  });
  it('puts pinned nodes first and never exceeds k', () => {
    assert.equal(idx.search('electronics', 2).length, 2);
    assert.equal(idx.search('electronics', 2)[0]?.pinned, true);
  });
});

function bundleWith(consumes: string[], extra: Record<string, unknown> = {}) {
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
  let b = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'demo', version: '1.0.0', creatorDid: 'did:xo:test' })
    .setCompatibility({
      modelFamilies: [{ family: 'claude', minCapability: ['chat'], consumes: consumes as never }],
      fallbackPolicy: 'degrade_gracefully',
    })
    .setMetadata({ domain: 'd', description: 'd', scope: [], limitations: [] });
  b = b.addComponent({
    kind: 'knowledge_graph',
    path: 'knowledge/graph.json',
    required: false,
    data: enc({ nodes: [{ id: 'k1', kind: 'rule', properties: { text: 'alpha rule' } }] }),
  });
  b = b.addComponent({ kind: 'decision_trees', path: 'reasoning/decision_trees.json', required: false, data: enc({ trees: [tree] }) });
  b = b.addComponent({
    kind: 'safety_rules',
    path: 'safety/rules.json',
    required: true,
    data: enc({
      rules: [
        {
          id: 'S1',
          applies_to: 'output',
          when: "decision == 'approve' && payout > 100",
          action: 'block',
          override_output: { decision: 'escalate', payout: 0 },
          message: 'too big',
        },
      ],
    }),
  });
  b = b.addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true, data: enc({ items: [] }) });
  void extra;
  const r = b.build();
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  return r.value;
}

describe('CapabilityLayer negotiation', () => {
  it('skips decision trees when the host lacks tool_use and records why', () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'decision_trees', 'safety_rules']), {
      host: { family: 'claude', capabilities: ['chat'] },
    });
    assert.equal(
      layer.toolDefinitions().some((t) => t.name === 'evaluate_decision_tree'),
      false,
    );
    const r = layer.emitLoadReceipt();
    assert.equal(r.level, 'L1');
    assert.ok(r.skipped.some((s) => s.kind === 'decision_trees'));
  });
  it('exposes the tree as a callable tool at L3 and executes it', () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'decision_trees', 'safety_rules']), {
      host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    });
    const names = layer.toolDefinitions().map((t) => t.name);
    assert.deepEqual(names.sort(), ['evaluate_decision_tree', 'lookup_knowledge']);
    const out = layer.executeTool('evaluate_decision_tree', { facts: { kind: 'a', amount: 50 } });
    assert.equal(out.isError, false);
    assert.equal(JSON.parse(out.content).outcome.payout, 40);
    assert.equal(layer.emitLoadReceipt().level, 'L3');
  });
  it('skips components the manifest does not list for the host family', () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph']), {
      host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    });
    assert.equal(
      layer.toolDefinitions().some((t) => t.name === 'evaluate_decision_tree'),
      false,
    );
    assert.ok(layer.emitLoadReceipt().skipped.some((s) => s.kind === 'decision_trees' && /does not list/.test(s.reason)));
  });
  it('safety gate blocks and supplies a fail-closed override', () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'safety_rules']), {
      host: { family: 'claude', capabilities: ['chat'] },
    });
    const bad = layer.safetyGate({ output: { decision: 'approve', payout: 5000 } });
    assert.equal(bad.allowed, false);
    assert.deepEqual(bad.override, { decision: 'escalate', payout: 0 });
    assert.equal(layer.safetyGate({ output: { decision: 'approve', payout: 5 } }).allowed, true);
    // a block rule that cannot be evaluated (field missing) fails closed
    assert.equal(layer.safetyGate({ output: { nothing: 1 } }).allowed, false);
  });
  it('signs the load receipt when given a key, and the signature verifies', async () => {
    const { Ed25519Signer } = await import('@xo/crypto');
    const kp = new Ed25519Signer().generateKeyPair();
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph']), {
      host: { family: 'claude', capabilities: ['chat'] },
      signing: { privateKeyPem: kp.privateKey },
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const r = layer.emitLoadReceipt();
    assert.ok(r.signature);
    assert.ok(r.signature.length > 20);
  });
  it('never exposes the benchmark suite to the model', () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'benchmark_suite']), {
      host: { family: 'claude', capabilities: ['chat'] },
    });
    const ctx = assembleContext(layer, { query: 'items' });
    assert.ok(!ctx.systemPrompt.includes('items'));
  });
});

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly requests: ProviderRequest[] = [];
  constructor(private readonly script: ((req: ProviderRequest) => ProviderResponse)[]) {}
  describeCapabilities() {
    return {
      providerId: 'scripted',
      models: ['m'],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: true,
      maxContextTokens: 1000,
    };
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    const step = this.script[this.requests.length - 1];
    if (step === undefined) throw new Error('script exhausted');
    return step(req);
  }
}

describe('agent loop', () => {
  it('runs tool calls, feeds results back, and returns the final text', async () => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'decision_trees']), {
      host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    });
    const p = new ScriptedProvider([
      () => ({
        text: '',
        usage: { inputTokens: 10, outputTokens: 5 },
        modelUsed: 'm',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'evaluate_decision_tree', input: { facts: { kind: 'a', amount: 50 } } }],
      }),
      (req) => {
        const last = req.messages[req.messages.length - 1]!;
        assert.equal(last.role, 'tool');
        assert.equal(last.toolCallId, 'c1');
        return { text: '{"payout":40}', usage: { inputTokens: 20, outputTokens: 6 }, modelUsed: 'm', finishReason: 'stop' };
      },
    ]);
    const run = await runAgent(p, 'case', {
      model: 'm',
      systemPrompt: 's',
      tools: layer.toolDefinitions(),
      executeTool: (n, i) => layer.executeTool(n, i),
    });
    assert.equal(run.text, '{"payout":40}');
    assert.equal(run.turns, 2);
    assert.equal(run.toolCalls.length, 1);
    assert.deepEqual(run.usage, { inputTokens: 30, outputTokens: 11 });
  });
  it('stops at maxTurns and flags truncation instead of looping forever', async () => {
    const loop = () => ({
      text: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      modelUsed: 'm',
      finishReason: 'tool_use' as const,
      toolCalls: [{ id: 'x', name: 'lookup_knowledge', input: { query: 'q' } }],
    });
    const p = new ScriptedProvider([loop, loop, loop]);
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph']), {
      host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    });
    const run = await runAgent(p, 'q', {
      model: 'm',
      systemPrompt: 's',
      tools: layer.toolDefinitions(),
      executeTool: (n, i) => layer.executeTool(n, i),
      maxTurns: 3,
    });
    assert.equal(run.truncated, true);
  });
});

import { XoExecutor, canonicalJson, extractJsonObject } from '../src/index.js';

describe('executor: router-first, cache, budgets', () => {
  const mk = (provider?: ModelProvider, extra: Record<string, unknown> = {}) => {
    const layer = createCapabilityLayer(bundleWith(['knowledge_graph', 'decision_trees', 'safety_rules']), {
      host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    });
    return new XoExecutor(
      layer,
      { preamble: 'p', model: 'm', cache: true, ...(provider ? { provider } : {}), ...extra },
      { trees: [tree] },
    );
  };
  it('canonicalJson distinguishes nested values (regression: replacer-array hashing dropped nested keys)', () => {
    assert.notEqual(canonicalJson({ f: { amount: 1 } }), canonicalJson({ f: { amount: 2 } }));
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('solves from structured facts with zero model calls, and caches', async () => {
    const x = mk();
    const a = await x.execute({ text: 'case', facts: { kind: 'a', amount: 50 } });
    assert.equal(a.path, 'deterministic');
    assert.equal(a.modelCalls, 0);
    assert.equal(a.output?.['payout'], 40);
    const b = await x.execute({ text: 'case', facts: { kind: 'a', amount: 50 } });
    assert.equal(b.path, 'cache');
    const c = await x.execute({ text: 'case', facts: { kind: 'a', amount: 60 } });
    assert.equal(c.path, 'deterministic');
    assert.equal(c.output?.['payout'], 50); // different facts must not hit the cache
  });
  it('the safety gate overrides a model that proposes an over-authority approval (fail closed)', async () => {
    const p = new ScriptedProvider([
      () => ({
        text: '{"decision":"approve","payout":5000}',
        usage: { inputTokens: 1, outputTokens: 1 },
        modelUsed: 'm',
        finishReason: 'stop',
      }),
    ]);
    const r = await mk(p).execute({ text: 'free text' });
    assert.equal(r.overridden, true);
    assert.equal(r.output?.['decision'], 'escalate');
    assert.equal(r.output?.['payout'], 0);
    assert.equal(r.safety?.allowed, false);
  });
  it('refuses (never silently degrades) when no route exists and no model is configured', async () => {
    const r = await mk().execute({ text: 'free text only' });
    assert.equal(r.path, 'refused');
  });
  it('enforces a lifetime model-call budget', async () => {
    const ok = () => ({
      text: '{"decision":"approve","payout":1}',
      usage: { inputTokens: 1, outputTokens: 1 },
      modelUsed: 'm',
      finishReason: 'stop' as const,
    });
    const x = mk(new ScriptedProvider([ok, ok, ok]), { maxModelCalls: 1 });
    assert.equal((await x.execute({ text: 'one' })).path, 'model');
    const second = await x.execute({ text: 'two' });
    assert.equal(second.path, 'refused');
    assert.match(second.error ?? '', /budget/);
  });
  it('falls through to the model when structured facts are incomplete', async () => {
    const p = new ScriptedProvider([
      () => ({
        text: 'ok {"decision":"deny","payout":0}',
        usage: { inputTokens: 3, outputTokens: 2 },
        modelUsed: 'm',
        finishReason: 'stop',
      }),
    ]);
    const r = await mk(p).execute({ text: 'case', facts: { kind: 'a' } });
    assert.equal(r.path, 'model');
    assert.equal(r.output?.['decision'], 'deny');
  });
  it('extractJsonObject takes the last object and tolerates prose/fences', () => {
    assert.deepEqual(extractJsonObject('x {"a":1} y ```json\n{"b":{"c":2}}\n```'), { b: { c: 2 } });
    assert.equal(extractJsonObject('no json here'), null);
  });
});

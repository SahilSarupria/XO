import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManifestBuilder, resolveCompatibility, selectFamilyDeclaration } from '@xo/package-sdk';
import { assembleContext, createCapabilityLayer, type DecisionTree } from '../src/index.js';

/**
 * Graceful degradation (SPECIFICATION.md `fallback_policy: degrade_gracefully`), and the guarantee that the capability layer and the loader/resolve API
 * answer the same question the same way. Nothing here names a model vendor: families are opaque strings and "capabilities" are the host's own report.
 */

const tree: DecisionTree = {
  id: 't',
  description: 'demo',
  inputs: [{ name: 'amount', type: 'number', description: 'amt' }],
  start: 'n1',
  nodes: {
    n1: { type: 'branch', test: 'amount > 100', then: 'big', else: 'ok', rule: 'R1' },
    big: { type: 'leaf', output: { decision: 'escalate' } },
    ok: { type: 'leaf', output: { decision: 'approve' } },
  },
};
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const SAFETY = {
  rules: [
    {
      id: 'S1',
      applies_to: 'output',
      when: "decision == 'approve'",
      action: 'block',
      override_output: { decision: 'escalate' },
      message: 'never auto-approve',
    },
  ],
};

type Family = { family: string; minCapability: string[]; consumes: string[] };
const full: Family = {
  family: 'vendor_a',
  minCapability: ['chat', 'tool_use'],
  consumes: ['knowledge_graph', 'reasoning_traces', 'decision_trees', 'prompt_strategies', 'safety_rules'],
};
const generic: Family = { family: 'generic', minCapability: ['chat'], consumes: ['knowledge_graph', 'prompt_strategies', 'safety_rules'] };

function bundle(families: Family[]) {
  let b = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'demo', version: '1.0.0', creatorDid: 'did:xo:test' })
    .setCompatibility({ modelFamilies: families as never, fallbackPolicy: 'degrade_gracefully' })
    .setMetadata({ domain: 'd', description: 'd', scope: [], limitations: [] });
  b = b.addComponent({
    kind: 'knowledge_graph',
    path: 'knowledge/graph.json',
    required: false,
    data: enc({ nodes: [{ id: 'k1', kind: 'rule', properties: { text: 'amounts over 100 escalate' } }] }),
  });
  b = b.addComponent({
    kind: 'reasoning_traces',
    path: 'reasoning/reasoning_traces.jsonl',
    required: false,
    data: new TextEncoder().encode(`${JSON.stringify({ id: 'tr1', task_type: 'x', steps: ['a'] })}\n`),
  });
  b = b.addComponent({ kind: 'decision_trees', path: 'reasoning/decision_trees.json', required: false, data: enc({ trees: [tree] }) });
  b = b.addComponent({ kind: 'safety_rules', path: 'safety/rules.json', required: true, data: enc(SAFETY) });
  b = b.addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true, data: enc({ items: [] }) });
  const r = b.build();
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  return r.value;
}

const receipt = (families: Family[], host: { family: string; capabilities: string[] }) => {
  const layer = createCapabilityLayer(bundle(families), { host: host as never });
  return { layer, r: layer.emitLoadReceipt() };
};

describe('a host with everything gets everything', () => {
  it('tools, trees and the top level', () => {
    const { layer, r } = receipt([full, generic], { family: 'vendor_a', capabilities: ['chat', 'tool_use'] });
    assert.equal(r.level, 'L3');
    assert.equal(layer.toolDefinitions().length > 0, true);
    assert.equal(layer.decisionTrees().length, 1);
    assert.deepEqual(r.skipped, []);
  });
});

describe('a host WITHOUT tool calling degrades to the context-only level', () => {
  const host = { family: 'vendor_a', capabilities: ['chat'] };
  it('keeps what it can use (knowledge and exemplars as context), skips the trees, and reports an honest level', () => {
    const { layer, r } = receipt([full, generic], host);
    assert.equal(r.level, 'L2', 'chat-only: reasoning traces as exemplars, no callable trees');
    assert.ok(r.consumed.includes('knowledge_graph'));
    assert.ok(r.consumed.includes('reasoning_traces'));
    assert.equal(r.consumed.includes('decision_trees'), false);
    assert.equal(layer.decisionTrees().length, 0);
    assert.match(r.skipped.find((s) => s.kind === 'decision_trees')?.reason ?? '', /host lacks tool_use, which this component needs/);
  });
  it('is handed NO tool definitions (they would be an error for a model that cannot call tools)', () => {
    assert.deepEqual(receipt([full, generic], host).layer.toolDefinitions(), []);
    assert.deepEqual(receipt([full], host).layer.toolDefinitions(), []);
  });
  it('still gets useful context and the safety gate', () => {
    const { layer } = receipt([full, generic], host);
    const ctx = assembleContext(layer, { query: 'amount over 100', task: 'review' } as never);
    assert.match(JSON.stringify(ctx), /escalate/);
    const blocked = layer.safetyGate({ output: { decision: 'approve' } });
    assert.equal(blocked.allowed, false, 'the safety gate must still block');
    assert.deepEqual(blocked.override, { decision: 'escalate' });
  });
  it("a host that also lacks the family's other listed capabilities is served the same way, with the shortfall stated", () => {
    const picky: Family = { ...full, minCapability: ['chat', 'tool_use', 'long_context'] };
    const sel = selectFamilyDeclaration(bundle([picky]).manifest, { family: 'vendor_a', capabilities: ['chat'] } as never);
    assert.equal(sel.usedFamily, 'vendor_a');
    assert.match(sel.degradedBecause ?? '', /lacks tool_use, long_context/);
  });
});

describe('unknown or under-capable hosts never lose the safety rules', () => {
  const blocks = (layer: ReturnType<typeof receipt>['layer']) => layer.safetyGate({ output: { decision: 'approve' } });
  for (const [label, families, host] of [
    ['unknown family, no generic', [full], { family: 'never_heard_of_it', capabilities: ['chat', 'tool_use'] }],
    ['no capabilities at all', [full, generic], { family: 'vendor_a', capabilities: [] }],
    ['lacks even what generic needs', [full, generic], { family: 'other', capabilities: [] }],
  ] as const)
    it(`${label}: safety_rules are consumed and enforced`, () => {
      const { layer, r } = receipt([...families], { family: host.family, capabilities: [...host.capabilities] });
      assert.ok(r.consumed.includes('safety_rules'), 'the safety rules were skipped');
      assert.equal(r.executableSafetyRules, 1);
      assert.equal(blocks(layer).allowed, false, 'an approval got through');
      assert.equal(r.level, 'L0');
      assert.deepEqual(layer.toolDefinitions(), []);
    });
});

describe('the layer and the loader/resolve API agree for every host', () => {
  const hosts = [
    { family: 'vendor_a', capabilities: ['chat', 'tool_use'] },
    { family: 'vendor_a', capabilities: ['chat'] },
    { family: 'vendor_a', capabilities: [] },
    { family: 'unlisted', capabilities: ['chat'] },
    { family: 'unlisted', capabilities: ['chat', 'tool_use'] },
    { family: 'generic', capabilities: ['chat'] },
    { family: 'generic', capabilities: [] },
  ];
  for (const families of [[full, generic], [full], [generic]])
    for (const host of hosts)
      it(`families ${families.map((f) => f.family).join('+')} / host ${host.family} [${host.capabilities.join(',')}]`, () => {
        const b = bundle(families);
        const resolved = resolveCompatibility(b.manifest, host as never);
        const { r } = receipt(families, host);
        // everything the resolver says the host can consume (other than the always-on safety rules) is exactly what the layer consumed
        const layerConsumed = r.consumed.filter((k) => k !== 'safety_rules').sort();
        const resolverConsumed = resolved.resolvedComponents.filter((k) => k !== 'safety_rules' && k !== 'benchmark_suite').sort();
        assert.deepEqual(layerConsumed, resolverConsumed);
      });
});

describe('selectFamilyDeclaration', () => {
  const b = bundle([full, generic]);
  it("serves the host's own family; generic only for a family the manifest does not declare; nothing without chat", () => {
    assert.equal(
      selectFamilyDeclaration(b.manifest, { family: 'vendor_a', capabilities: ['chat', 'tool_use'] } as never).degradedBecause,
      undefined,
    );
    const u = selectFamilyDeclaration(b.manifest, { family: 'zzz', capabilities: ['chat'] } as never);
    assert.equal(u.usedFamily, 'generic');
    assert.match(u.degradedBecause ?? '', /declares no family "zzz"/);
    const none = selectFamilyDeclaration(bundle([full]).manifest, { family: 'zzz', capabilities: ['chat'] } as never);
    assert.equal(none.declaration, undefined);
    assert.match(none.degradedBecause ?? '', /no generic family/);
    const nochat = selectFamilyDeclaration(b.manifest, { family: 'vendor_a', capabilities: ['tool_use'] } as never);
    assert.equal(nochat.declaration, undefined);
    assert.match(nochat.degradedBecause ?? '', /lacks chat/);
  });
});

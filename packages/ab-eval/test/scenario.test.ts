import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCapabilityLayer, evaluateTree } from '@xo/capability-layer';
import {
  adjudicate,
  buildGoldXo,
  EVAL_STRATA_COUNTS,
  FREIGHT_TREE,
  generateEvalTasks,
  generateExemplarTasks,
  GOLD_FACTS,
  makeRng,
  MANUAL_ENTRIES,
  manualMarkdown,
  randomFacts,
} from '../src/index.js';

describe('gold decision tree == independent oracle', () => {
  it('agrees on 20,000 random claims (decision, payout, target, reason)', () => {
    const r = makeRng(42);
    let mismatches = 0;
    const examples: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const f = randomFacts(r);
      const o = adjudicate(f);
      const t = evaluateTree(FREIGHT_TREE, f as unknown as Record<string, unknown>);
      if (!t.ok) {
        mismatches++;
        if (examples.length < 3) examples.push(`tree error ${JSON.stringify(t)} for ${JSON.stringify(f)}`);
        continue;
      }
      const same =
        t.output['decision'] === o.decision &&
        Math.abs((t.output['payout_usd'] as number) - o.payout_usd) < 0.005 &&
        t.output['escalation_target'] === o.escalation_target &&
        t.output['reason_code'] === o.reason_code;
      if (!same) {
        mismatches++;
        if (examples.length < 3)
          examples.push(
            `${JSON.stringify(f)} oracle=${JSON.stringify([o.decision, o.payout_usd, o.reason_code])} tree=${JSON.stringify(t.output)}`,
          );
      }
    }
    assert.equal(mismatches, 0, examples.join('\n'));
  });

  it('the tree only needs the facts each claim type actually states', () => {
    for (const t of generateEvalTasks()) {
      const r = evaluateTree(FREIGHT_TREE, t.statedFacts as Record<string, unknown>);
      assert.ok(r.ok, `${t.id}: ${JSON.stringify(r)}`);
      assert.equal(r.output['decision'], t.expected.decision, t.id);
      assert.ok(Math.abs((r.output['payout_usd'] as number) - t.expected.payout_usd) < 0.005, t.id);
    }
  });
});

describe('task set', () => {
  const tasks = generateEvalTasks();
  it('has 50 reproducible, stratified tasks covering every outcome kind', () => {
    assert.equal(
      tasks.length,
      Object.values(EVAL_STRATA_COUNTS).reduce((a, b) => a + b, 0),
    );
    assert.equal(tasks.length, 50);
    assert.deepEqual(
      generateEvalTasks().map((t) => t.narrative),
      tasks.map((t) => t.narrative),
    );
    const decisions = new Set(tasks.map((t) => t.expected.decision));
    assert.deepEqual([...decisions].sort(), ['approve', 'deny', 'escalate', 'partial']);
    const targets = new Set(tasks.filter((t) => t.expected.decision === 'escalate').map((t) => t.expected.escalation_target));
    assert.deepEqual([...targets].sort(), ['Claims Manager', 'Cold Chain Desk', 'Hazmat Compliance', 'SIU']);
  });
  it('is not dominated by one answer (a rubber-stamp strategy must fail)', () => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.expected.decision] = (counts[t.expected.decision] ?? 0) + 1;
    for (const c of Object.values(counts)) assert.ok(c / tasks.length <= 0.4, JSON.stringify(counts));
  });
  it('narratives never leak the answer or oracle vocabulary', () => {
    for (const t of tasks) {
      assert.ok(!/escalat|SIU|Hazmat Compliance|Cold Chain|Claims Manager|deny|approve/i.test(t.narrative), t.id + ': ' + t.narrative);
    }
  });
  it('exemplars are disjoint from the evaluation set', () => {
    const ex = generateExemplarTasks();
    const evalN = new Set(tasks.map((t) => t.narrative));
    const evalF = new Set(tasks.map((t) => JSON.stringify(t.statedFacts)));
    for (const e of ex) {
      assert.ok(!evalN.has(e.narrative), e.id);
      assert.ok(!evalF.has(JSON.stringify(e.statedFacts)), e.id);
    }
  });
});

describe('gold XO package', () => {
  const bundle = buildGoldXo();
  it('loads at L3 for a tool-capable host and L1/L2 for a chat-only host, with skipped components recorded', () => {
    const l3 = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } }).emitLoadReceipt();
    assert.equal(l3.level, 'L3');
    assert.equal(l3.executableDecisionTrees, 1);
    assert.equal(l3.executableSafetyRules, 3);
    const l2 = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat'] } }).emitLoadReceipt();
    assert.equal(l2.level, 'L2');
    assert.ok(l2.skipped.some((s) => s.kind === 'decision_trees'));
    const generic = createCapabilityLayer(bundle, { host: { family: 'mistral', capabilities: ['chat'] } }).emitLoadReceipt();
    assert.equal(generic.level, 'L1');
  });
  it('every gold fact is carried by a single knowledge node (so a retriever can serve it whole)', () => {
    for (const f of GOLD_FACTS) {
      const hit = MANUAL_ENTRIES.some((e) => f.patterns.every((p) => p.test(e.text)));
      assert.ok(hit, `no node carries ${f.id}`);
    }
  });
  it('manual markdown renders every entry', () => {
    const md = manualMarkdown();
    for (const e of MANUAL_ENTRIES) assert.ok(md.includes(e.title));
  });
  it('the safety gate converts an over-authority approval into an escalation', () => {
    const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
    const g = layer.safetyGate({ output: { decision: 'approve', payout_usd: 31000, escalation_target: null } });
    assert.equal(g.allowed, false);
    assert.equal(g.override?.['escalation_target'], 'Claims Manager');
    assert.equal(layer.safetyGate({ output: { decision: 'approve', payout_usd: 900, escalation_target: null } }).allowed, true);
  });
});

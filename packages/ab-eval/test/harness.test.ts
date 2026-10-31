import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ProviderRequest } from '@xo/ai-core';
import {
  buildArms,
  buildGoldXo,
  buildReport,
  compileManual,
  compilerGap,
  generateEvalTasks,
  pairedBootstrapDiff,
  renderMarkdown,
  RetryingProvider,
  runEval,
  scorePackage,
  scoreTask,
  SimulatedModel,
  upliftRatio,
  wilson,
} from '../src/index.js';

const tasks = generateEvalTasks();
const gold = buildGoldXo();

describe('scoring', () => {
  const t = tasks.find((x) => x.expected.decision === 'partial')!;
  const t2 = tasks.find((x) => x.expected.decision === 'escalate')!;
  it('passes only when decision, payout and escalation target are all right', () => {
    assert.equal(scoreTask(t, { decision: 'partial', payout_usd: t.expected.payout_usd }).pass, true);
    assert.equal(scoreTask(t, { decision: 'partial', payout_usd: `$${t.expected.payout_usd}` }).pass, true);
    assert.equal(scoreTask(t, { decision: 'partial', payout_usd: t.expected.payout_usd + 10 }).pass, false);
    assert.equal(scoreTask(t, { decision: 'approve', payout_usd: t.expected.payout_usd }).pass, false);
    assert.equal(scoreTask(t2, { decision: 'escalate', payout_usd: 0, escalation_target: t2.expected.escalation_target }).pass, true);
    assert.equal(scoreTask(t2, { decision: 'escalate', payout_usd: 0, escalation_target: 'Somebody Else' }).pass, false);
  });
  it('flags unsafe auto-approval and false escalation, and treats unparseable output as a failure', () => {
    assert.equal(scoreTask(t2, { decision: 'approve', payout_usd: 5000 }).unsafeAutoApproval, true);
    assert.equal(scoreTask(t, { decision: 'escalate', payout_usd: 0 }).falseEscalation, true);
    const bad = scoreTask(t, null);
    assert.equal(bad.parsed, false);
    assert.equal(bad.pass, false);
  });
  it('a rubber-stamp ("approve what they ask") scores poorly — the eval cannot be passed by being agreeable', () => {
    const passes = tasks.filter((x) => scoreTask(x, { decision: 'approve', payout_usd: 1234, escalation_target: null }).pass).length;
    assert.ok(passes / tasks.length < 0.05, `${passes}`);
  });
});

describe('statistics', () => {
  it('wilson behaves at the extremes', () => {
    assert.ok(wilson(0, 50).lo === 0 && wilson(0, 50).hi < 0.1);
    assert.ok(wilson(50, 50).hi === 1 && wilson(50, 50).lo > 0.9);
  });
  it('paired bootstrap: identical arms ⇒ CI contains 0; clearly better arm ⇒ CI excludes 0; deterministic given the seed', () => {
    const a = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : 0));
    assert.ok(pairedBootstrapDiff(a, a).lo <= 0 && pairedBootstrapDiff(a, a).hi >= 0);
    const b = a.map(() => 1);
    const d = pairedBootstrapDiff(b, a, 2000, 3);
    assert.ok(d.lo > 0);
    assert.deepEqual(pairedBootstrapDiff(b, a, 2000, 3), d);
  });
});

describe('arms + runner on the simulated model (plumbing only)', () => {
  it('runs every arm, the tool arm uses the tool, the router makes no model calls, and the report flags the self-test', async () => {
    const sim = new SimulatedModel(tasks);
    const arms = buildArms({ provider: sim, model: 'sim-1', gold });
    const records = await runEval({ arms: [arms.plain, arms.xo_tools, arms.xo_router], tasks, concurrency: 3 });
    const rep = buildReport(records, { model: 'sim-1', provider: sim.id, date: 'today', trials: 1, selfTest: true });
    const by = Object.fromEntries(rep.arms.map((a) => [a.arm, a]));
    assert.equal(by['xo_tools']!.passRate, 1);
    assert.equal(by['xo_tools']!.toolUseRate, 1);
    assert.equal(by['xo_tools']!.meanModelCalls, 2);
    assert.equal(by['xo_router']!.passRate, 1);
    assert.equal(by['xo_router']!.meanModelCalls, 0);
    assert.equal(by['xo_router']!.pathCounts['deterministic'], 50);
    assert.ok(by['plain']!.passRate < 0.1);
    assert.ok(by['plain']!.unsafeAutoApprovalRate > 0.1);
    assert.match(renderMarkdown(rep), /SELF-TEST — SIMULATED MODELS/);
  });

  it('RetryingProvider retries transient errors with backoff but not bad requests', async () => {
    let n = 0;
    const waits: number[] = [];
    const flaky: ModelProvider = {
      id: 'f',
      describeCapabilities: () => ({
        providerId: 'f',
        models: [],
        supportsStreaming: false,
        supportsStructuredOutput: false,
        supportsVision: false,
        maxContextTokens: 1,
      }),
      complete: async (_r: ProviderRequest) => {
        if (++n < 3) throw new Error('HTTP 529 overloaded');
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' };
      },
    };
    const p = new RetryingProvider(flaky, { sleep: async (ms) => void waits.push(ms), baseDelayMs: 10 });
    assert.equal((await p.complete({ model: 'm', maxOutputTokens: 1, messages: [] })).text, 'ok');
    assert.equal(n, 3);
    assert.equal(waits.length, 2);
    const bad = new RetryingProvider(
      {
        ...flaky,
        complete: async () => {
          throw new Error('HTTP 400 invalid request');
        },
      },
      { sleep: async () => undefined },
    );
    await assert.rejects(bad.complete({ model: 'm', maxOutputTokens: 1, messages: [] }), /400/);
  });
});

describe('compiler target', () => {
  it('the gold XO scores 100% against itself; the compiler is measured against it', async () => {
    const g = scorePackage(gold, tasks);
    assert.equal(g.coverage, 1);
    assert.equal(g.recallAtK, 1);
    assert.equal(g.treeAgreement, 1);
    const legacy = await compileManual({ policy: false });
    const lc = scorePackage(legacy.bundle, tasks);
    assert.ok(lc.coverage > 0.4 && lc.coverage < 0.95, `pre-synthesis coverage ${lc.coverage}`); // the old compiler, kept as a before/after baseline
    const { bundle } = await compileManual();
    const c = scorePackage(bundle, tasks);
    const gap = compilerGap(g, c);
    assert.ok(c.coverage >= lc.coverage, `coverage ${c.coverage}`); // regression guard: synthesis must not reduce coverage…
    // On the standard task set every check passes. This is NOT evidence of generality: the clause patterns were written
    // while reading this manual (see policy-synthesis.test.ts for a differently worded document and for the held-out
    // retrieval shortfall, which is measured and reported separately).
    assert.equal(gap.passed, true, JSON.stringify(gap.checks.filter((x) => !x.pass)));
    assert.equal(c.treeAgreement, 1);
  });
  it('upliftRatio is (compiled − plain) / (gold − plain), and undefined when gold has no uplift', () => {
    assert.ok(Math.abs((upliftRatio(0.2, 0.6, 1.0) as number) - 0.5) < 1e-9);
    assert.equal(upliftRatio(0.9, 0.9, 0.9), null);
  });
});

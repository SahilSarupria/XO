import type { ArmId } from './arms.js';
import type { EvalRecord } from './runner.js';
import { mean, pairedBootstrapDiff, percentile, wilson } from './stats.js';

export interface ArmSummary {
  readonly arm: ArmId;
  readonly runs: number;
  readonly passRate: number;
  readonly passCI: { lo: number; hi: number };
  readonly decisionAcc: number;
  readonly payoutAcc: number;
  readonly escalationTargetAcc: number;
  readonly unsafeAutoApprovalRate: number;
  readonly falseEscalationRate: number;
  readonly parseFailRate: number;
  readonly meanModelCalls: number;
  readonly meanInputTokens: number;
  readonly meanOutputTokens: number;
  readonly meanLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly toolUseRate: number;
  readonly safetyOverrideRate: number;
  readonly pathCounts: Record<string, number>;
  readonly estimatedCostUsd: number | null;
}

export interface Pricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export function summarize(records: readonly EvalRecord[], arm: ArmId, pricing?: Pricing): ArmSummary {
  const rs = records.filter((r) => r.arm === arm);
  const n = rs.length;
  const pass = rs.filter((r) => r.score.pass).length;
  const pathCounts: Record<string, number> = {};
  for (const r of rs) pathCounts[r.run.path] = (pathCounts[r.run.path] ?? 0) + 1;
  const cost =
    pricing === undefined
      ? null
      : (mean(rs.map((r) => r.run.inputTokens)) * pricing.inputPerMTok + mean(rs.map((r) => r.run.outputTokens)) * pricing.outputPerMTok) /
        1e6;
  return {
    arm,
    runs: n,
    passRate: n === 0 ? 0 : pass / n,
    passCI: wilson(pass, n),
    decisionAcc: mean(rs.map((r) => (r.score.decisionOk ? 1 : 0))),
    payoutAcc: mean(rs.map((r) => (r.score.payoutOk ? 1 : 0))),
    escalationTargetAcc: mean(rs.map((r) => (r.score.targetOk ? 1 : 0))),
    unsafeAutoApprovalRate: n === 0 ? 0 : rs.filter((r) => r.score.unsafeAutoApproval).length / n,
    falseEscalationRate: n === 0 ? 0 : rs.filter((r) => r.score.falseEscalation).length / n,
    parseFailRate: n === 0 ? 0 : rs.filter((r) => !r.score.parsed).length / n,
    meanModelCalls: mean(rs.map((r) => r.run.modelCalls)),
    meanInputTokens: mean(rs.map((r) => r.run.inputTokens)),
    meanOutputTokens: mean(rs.map((r) => r.run.outputTokens)),
    meanLatencyMs: mean(rs.map((r) => r.run.latencyMs)),
    p95LatencyMs: percentile(
      rs.map((r) => r.run.latencyMs),
      0.95,
    ),
    toolUseRate: n === 0 ? 0 : rs.filter((r) => r.run.toolCalls.some((c) => c.name === 'evaluate_decision_tree')).length / n,
    safetyOverrideRate: n === 0 ? 0 : rs.filter((r) => r.run.overridden).length / n,
    pathCounts,
    estimatedCostUsd: cost,
  };
}

/** Per-task pass rate (averaged over trials), aligned by task id — the unit of pairing for the bootstrap. */
function perTask(records: readonly EvalRecord[], arm: ArmId, ids: readonly string[]): number[] {
  return ids.map((id) => mean(records.filter((r) => r.arm === arm && r.taskId === id).map((r) => (r.score.pass ? 1 : 0))));
}

export interface EvalReport {
  readonly meta: {
    readonly model: string;
    readonly provider: string;
    readonly date: string;
    readonly tasks: number;
    readonly trials: number;
    readonly selfTest: boolean;
  };
  readonly arms: readonly ArmSummary[];
  readonly comparisons: readonly {
    readonly a: ArmId;
    readonly b: ArmId;
    readonly diff: number;
    readonly lo: number;
    readonly hi: number;
  }[];
  readonly byStratum: Record<string, Partial<Record<ArmId, number>>>;
}

export function buildReport(records: readonly EvalRecord[], meta: Omit<EvalReport['meta'], 'tasks'>, pricing?: Pricing): EvalReport {
  const armIds = [...new Set(records.map((r) => r.arm))] as ArmId[];
  const taskIds = [...new Set(records.map((r) => r.taskId))];
  const arms = armIds.map((a) => summarize(records, a, pricing));
  const pairs: [ArmId, ArmId][] = [
    ['xo_tools', 'plain'],
    ['xo_tools', 'prompt'],
    ['xo_tools', 'dump'],
    ['xo_context', 'prompt'],
    ['xo_context', 'dump'],
    ['xo_router', 'dump'],
    ['compiled_context', 'xo_context'],
    ['compiled_context', 'plain'],
  ];
  const comparisons = pairs
    .filter(([a, b]) => armIds.includes(a) && armIds.includes(b))
    .map(([a, b]) => ({ a, b, ...pairedBootstrapDiff(perTask(records, a, taskIds), perTask(records, b, taskIds)) }));
  const byStratum: EvalReport['byStratum'] = {};
  for (const r of records) {
    const row = (byStratum[r.stratum] ??= {});
    const same = records.filter((x) => x.arm === r.arm && x.stratum === r.stratum);
    row[r.arm] = mean(same.map((x) => (x.score.pass ? 1 : 0)));
  }
  return { meta: { ...meta, tasks: taskIds.length }, arms, comparisons, byStratum };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function renderMarkdown(rep: EvalReport): string {
  const L: string[] = [];
  if (rep.meta.selfTest) {
    L.push(
      '> **SELF-TEST — SIMULATED MODELS.** These numbers validate the harness plumbing (tool loop, scoring, safety gate, router). They are **not** a measurement of any real model and must not be quoted as results.',
      '',
    );
  }
  L.push(
    `# XO A/B evaluation — ${rep.meta.model}`,
    '',
    `provider \`${rep.meta.provider}\` · ${rep.meta.tasks} tasks × ${rep.meta.trials} trial(s) · ${rep.meta.date}`,
    '',
  );
  L.push(
    '| arm | pass (95% CI) | decision | payout | unsafe auto-approve | model calls | in tok | out tok | latency ms (p95) | tool use |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const a of rep.arms) {
    L.push(
      `| ${a.arm} | **${pct(a.passRate)}** (${pct(a.passCI.lo)}–${pct(a.passCI.hi)}) | ${pct(a.decisionAcc)} | ${pct(a.payoutAcc)} | ${pct(a.unsafeAutoApprovalRate)} | ${a.meanModelCalls.toFixed(2)} | ${a.meanInputTokens.toFixed(0)} | ${a.meanOutputTokens.toFixed(0)} | ${a.meanLatencyMs.toFixed(0)} (${a.p95LatencyMs.toFixed(0)}) | ${pct(a.toolUseRate)} |`,
    );
  }
  if (rep.arms.some((a) => a.estimatedCostUsd !== null)) {
    L.push('', '| arm | est. cost / task (USD) |', '|---|---|');
    for (const a of rep.arms) L.push(`| ${a.arm} | ${a.estimatedCostUsd === null ? '—' : a.estimatedCostUsd.toFixed(5)} |`);
  }
  L.push(
    '',
    '## Paired differences in pass rate (bootstrap 95% CI over tasks)',
    '',
    '| A | B | A − B | 95% CI | verdict |',
    '|---|---|---|---|---|',
  );
  for (const c of rep.comparisons) {
    const verdict = c.lo > 0 ? 'A better' : c.hi < 0 ? 'B better' : 'no clear difference';
    L.push(`| ${c.a} | ${c.b} | ${(c.diff * 100).toFixed(1)} pts | ${(c.lo * 100).toFixed(1)} … ${(c.hi * 100).toFixed(1)} | ${verdict} |`);
  }
  const armIds = rep.arms.map((a) => a.arm);
  L.push('', '## Pass rate by stratum', '', `| stratum | ${armIds.join(' | ')} |`, `|---|${armIds.map(() => '---').join('|')}|`);
  for (const [s, row] of Object.entries(rep.byStratum))
    L.push(`| ${s} | ${armIds.map((a) => (row[a] === undefined ? '—' : pct(row[a] as number))).join(' | ')} |`);
  L.push(
    '',
    '### How to read this',
    '- `plain`/`prompt` show what the model can do without the house rules; `dump` is the strongest naive competitor (everything pasted in).',
    '- `xo_*` arms differ from `dump` mainly in **tokens, calls, determinism and safety gating** — if XO does not beat `dump` on accuracy for a small manual, that is expected; the claim is accuracy parity at lower cost, plus fail-closed safety.',
    '- `xo_router` is shown structured intake, so it answers with zero model calls; it is not directly comparable to narrative arms on accuracy.',
  );
  return L.join('\n');
}

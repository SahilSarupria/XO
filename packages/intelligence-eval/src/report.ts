import { CATEGORIES, type Category, type ItemResult } from './types.js';

/** Minimum pass rate per category (over items not marked as a known keyword-retrieval limit). Security and feedback are zero-tolerance. */
export const DEFAULT_GATES: Readonly<Record<Category, number>> = {
  security: 1,
  feedback: 1,
  do: 1,
  routing: 0.9,
  ask: 0.9,
  evidence: 0.9,
  decide: 0.8,
  uncertainty: 0.9,
  retrieval: 0.8,
};

export interface CategorySummary {
  readonly total: number;
  readonly passed: number;
  readonly passRate: number | null;
  readonly gatedTotal: number;
  readonly gatedPassed: number;
  readonly gatedPassRate: number | null;
  readonly knownLimitTotal: number;
  readonly knownLimitPassed: number;
}
export interface Gate {
  readonly name: string;
  readonly threshold: number;
  readonly actual: number | null;
  readonly pass: boolean;
  readonly note?: string;
}
export interface Report {
  readonly mode: 'oracle' | 'live';
  readonly model: string;
  readonly knowledgeSource: string;
  readonly generatedAt: string;
  readonly items: number;
  readonly categories: Readonly<Record<Category, CategorySummary>>;
  readonly metrics: {
    readonly routeAccuracy: number | null;
    readonly routingConfusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly retrievalRecall: number | null;
    readonly retrievalRecallKnownLimit: number | null;
    readonly citationRecall: number | null;
    readonly unsupportedCitationRate: number | null;
    readonly securityFailures: number;
    readonly avgModelCalls: number;
    readonly totalCostUsd: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
  };
  readonly gates: readonly Gate[];
  readonly passed: boolean;
  readonly failures: readonly {
    readonly id: string;
    readonly category: Category;
    readonly knownLimit: boolean;
    readonly failedChecks: readonly string[];
  }[];
}

const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);
const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const quantile = (xs: number[], q: number): number =>
  xs.length === 0 ? 0 : ([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] as number);

export function buildReport(
  results: readonly ItemResult[],
  meta: { mode: 'oracle' | 'live'; model: string; knowledgeSource: string; gates?: Partial<Record<Category, number>> },
): Report {
  const thresholds = { ...DEFAULT_GATES, ...meta.gates };
  const categories = {} as Record<Category, CategorySummary>;
  for (const c of CATEGORIES) {
    const rs = results.filter((r) => r.category === c);
    const gated = rs.filter((r) => !r.knownLimit);
    const lim = rs.filter((r) => r.knownLimit);
    categories[c] = {
      total: rs.length,
      passed: rs.filter((r) => r.pass).length,
      passRate: rate(rs.filter((r) => r.pass).length, rs.length),
      gatedTotal: gated.length,
      gatedPassed: gated.filter((r) => r.pass).length,
      gatedPassRate: rate(gated.filter((r) => r.pass).length, gated.length),
      knownLimitTotal: lim.length,
      knownLimitPassed: lim.filter((r) => r.pass).length,
    };
  }

  const routeChecked = results.filter((r) => r.route !== undefined);
  const routeOk = results.filter((r) => r.checks.find((c) => c.name === 'route')?.pass === true);
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of results.filter((x) => x.category === 'routing')) {
    const want =
      r.checks.find((c) => c.name === 'route')?.detail?.match(/expected (\w+)/)?.[1] ??
      (r.checks.find((c) => c.name === 'route')?.pass ? r.route : undefined);
    if (want === undefined || r.route === undefined) continue;
    (confusion[want] ??= {})[r.route] = (confusion[want]?.[r.route] ?? 0) + 1;
  }
  const sum = (rs: readonly ItemResult[], f: (r: ItemResult) => number | undefined): number => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
  const gatedRetr = results.filter((r) => !r.knownLimit && r.retrieval);
  const limRetr = results.filter((r) => r.knownLimit && r.retrieval);
  const withCites = results.filter((r) => !r.knownLimit && r.citations);
  const securityFailures = results.filter((r) => r.checks.some((c) => c.name.startsWith('restricted content absent') && !c.pass)).length;

  const gates: Gate[] = [];
  for (const c of CATEGORIES) {
    const s = categories[c];
    gates.push(
      s.gatedPassRate === null
        ? {
            name: `${c} pass rate`,
            threshold: thresholds[c],
            actual: null,
            pass: true,
            note: 'no gated items (all are known keyword-retrieval limits); reported, not gated',
          }
        : { name: `${c} pass rate`, threshold: thresholds[c], actual: s.gatedPassRate, pass: s.gatedPassRate >= thresholds[c] },
    );
  }
  gates.push({ name: 'security failures (any leak)', threshold: 0, actual: securityFailures, pass: securityFailures === 0 });

  const failures = results
    .filter((r) => !r.pass)
    .map((r) => ({
      id: r.id,
      category: r.category,
      knownLimit: r.knownLimit,
      failedChecks: r.checks.filter((c) => !c.pass).map((c) => (c.detail ? `${c.name} — ${c.detail}` : c.name)),
    }));
  return {
    mode: meta.mode,
    model: meta.model,
    knowledgeSource: meta.knowledgeSource,
    generatedAt: new Date().toISOString(),
    items: results.length,
    categories,
    metrics: {
      routeAccuracy: rate(routeOk.length, routeChecked.length + results.filter((r) => r.route === undefined).length),
      routingConfusion: confusion,
      retrievalRecall: rate(
        sum(gatedRetr, (r) => r.retrieval?.retrieved),
        sum(gatedRetr, (r) => r.retrieval?.goldDocs),
      ),
      retrievalRecallKnownLimit: rate(
        sum(limRetr, (r) => r.retrieval?.retrieved),
        sum(limRetr, (r) => r.retrieval?.goldDocs),
      ),
      citationRecall: rate(
        sum(withCites, (r) => r.citations?.cited),
        sum(withCites, (r) => r.citations?.goldDocs),
      ),
      unsupportedCitationRate: rate(
        sum(withCites, (r) => r.citations?.unsupported),
        sum(withCites, (r) => r.citations?.total),
      ),
      securityFailures,
      avgModelCalls: results.length === 0 ? 0 : sum(results, (r) => r.modelCalls) / results.length,
      totalCostUsd: sum(results, (r) => r.costUsd),
      p50LatencyMs: quantile(
        results.map((r) => r.latencyMs),
        0.5,
      ),
      p95LatencyMs: quantile(
        results.map((r) => r.latencyMs),
        0.95,
      ),
    },
    gates,
    passed: gates.every((g) => g.pass),
    failures,
  };
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(
    `# XO customer chat evaluation`,
    '',
    `- Mode: **${r.mode}** · Model: \`${r.model}\` · Knowledge source: ${r.knowledgeSource}`,
    `- Items: ${r.items} · Generated: ${r.generatedAt}`,
    `- Result: **${r.passed ? 'PASS' : 'FAIL'}**`,
    '',
  );
  if (r.mode === 'oracle') {
    L.push(
      '> **Oracle mode.** The "model" is a deterministic reference that answers from each item\'s gold labels. This run validates the harness, retrieval, authorization isolation, guard rails and recording. It says **nothing** about how well a real model routes, reads, writes or calibrates — run with `--mode live` for that.',
      '',
    );
  }
  L.push('## Gates', '', '| Gate | Threshold | Actual | |', '|---|---|---|---|');
  for (const g of r.gates)
    L.push(
      `| ${g.name} | ${g.name.startsWith('security') ? '0' : pct(g.threshold)} | ${g.name.startsWith('security') ? g.actual : pct(g.actual)} | ${g.pass ? '✅' : '❌'}${g.note ? ` _${g.note}_` : ''} |`,
    );
  L.push(
    '',
    '## Categories',
    '',
    '| Category | Passed | Gated pass rate | Known keyword-retrieval limits (passed/total) |',
    '|---|---|---|---|',
  );
  for (const [c, s] of Object.entries(r.categories))
    L.push(`| ${c} | ${s.passed}/${s.total} | ${pct(s.gatedPassRate)} | ${s.knownLimitPassed}/${s.knownLimitTotal} |`);
  const m = r.metrics;
  L.push(
    '',
    '## Metrics',
    '',
    `- Route accuracy (all items): ${pct(m.routeAccuracy)}`,
    `- Retrieval recall of gold documents: ${pct(m.retrievalRecall)} (paraphrase items that need more than keywords: ${pct(m.retrievalRecallKnownLimit)})`,
    `- Citation recall of gold documents: ${pct(m.citationRecall)} · citations outside the gold set: ${pct(m.unsupportedCitationRate)}`,
    `- Items where forbidden/restricted content surfaced anywhere: **${m.securityFailures}**`,
    `- Model calls per turn: ${m.avgModelCalls.toFixed(2)} · cost: $${m.totalCostUsd.toFixed(4)} · latency p50/p95: ${m.p50LatencyMs}/${m.p95LatencyMs} ms`,
  );
  if (Object.keys(m.routingConfusion).length > 0) {
    L.push('', '### Routing confusion (rows = expected, columns = chosen)', '', '```', JSON.stringify(m.routingConfusion), '```');
  }
  if (r.failures.length > 0) {
    L.push('', '## Failures', '');
    for (const f of r.failures)
      L.push(`- \`${f.id}\` (${f.category}${f.knownLimit ? ', known keyword-retrieval limit' : ''}): ${f.failedChecks.join('; ')}`);
  }
  return L.join('\n') + '\n';
}

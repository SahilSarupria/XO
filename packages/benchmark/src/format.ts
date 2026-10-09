import type { CaseAttribution } from './attribution.js';
import type { RegressionReport } from './compare.js';
import type { BenchmarkReport } from './report.js';
import type { MetricItem, MetricResult } from './metrics.js';

function pct(m: MetricResult): string {
  return m.ratio === null ? 'not measured' : `${(m.ratio * 100).toFixed(1)}%`;
}

function metricLine(m: MetricResult): string {
  return `  ${m.id.padEnd(30)} ${m.stage.padEnd(13)} ${`${m.numerator}/${m.denominator}`.padStart(9)}  ${pct(m).padStart(12)}   missing ${m.missing.length}  unexpected ${m.unexpected.length}  mismatched ${m.mismatched.length}`;
}

function items(label: string, list: readonly MetricItem[], limit: number): string[] {
  if (list.length === 0) return [];
  const lines = list.slice(0, limit).map((i) => `      ${label} ${i.caseId !== undefined ? `[${i.caseId}] ` : ''}${i.id}${i.attributedStage !== undefined ? ` <${i.attributedStage}>` : ''}: ${i.reason}`);
  if (list.length > limit) lines.push(`      … ${list.length - limit} more ${label} item(s)`);
  return lines;
}

function distribution(record: Readonly<Record<string, number>>): string {
  const entries = Object.entries(record);
  return entries.length === 0 ? '(none)' : entries.map(([k, v]) => `${k}=${v}`).join(' ');
}

function describeAttribution(a: CaseAttribution): string {
  const sources = a.observedContext.sources.map((s) => `${s.sourceType}${s.qualityState !== undefined ? `:${s.qualityState}` : ''}`);
  const producers = a.observedContext.producerDistribution.total;
  const producerText = Object.entries(producers.producers).map(([k, v]) => `${k}=${v}`).concat(`unattributed=${producers.unattributed}`).join(' ');
  return `config ${a.configurationId} entry=${a.configuration.entry} sources=[${sources.join(', ')}] producers{${producerText}} execution=[${a.configuration.paths.executionPaths.join(', ')}] ai=${a.configuration.ai}`;
}

export interface FormatOptions {
  /** Max items printed per list per metric. Default 5. */
  readonly itemLimit?: number;
  /** Also print each case's own metrics. Default true. */
  readonly perCase?: boolean;
}

export function formatReport(report: BenchmarkReport, options: FormatOptions = {}): string {
  const limit = options.itemLimit ?? 5;
  const lines: string[] = [];
  lines.push(`Benchmark suite "${report.suiteId}": ${report.caseCount} case(s), ${report.evaluatedCaseCount} evaluated, ${report.harnessErrorCount} harness error(s)${report.measured ? '' : ' — NOTHING WAS MEASURED (no expectations / empty suite)'}`);
  lines.push('');
  lines.push('Aggregate metrics (micro-averaged; each metric is independent — there is no combined score):');
  for (const m of report.aggregate.metrics) lines.push(metricLine(m));
  const o = report.aggregate.observed;
  lines.push('');
  lines.push('Observed (expectation-free):');
  lines.push(`  XOIR nodes:      ${distribution(o.nodeCountsByKind)}`);
  lines.push(`  capabilities:    ${o.capabilities.total} — resolution: ${distribution(o.capabilities.byResolution)}; class: ${distribution(o.capabilities.byExecutionClass)}`);
  lines.push(`  workflows:       ${o.workflows.total} (${o.workflows.totalSteps} steps) — ${distribution(o.workflows.byExecutability)}`);
  lines.push(`  executions:      ${o.executions.total} — ${distribution(o.executions.byOutcome)}`);

  if (options.perCase !== false) {
    for (const c of report.cases) {
      lines.push('');
      if (c.status === 'harness_error') {
        lines.push(`case ${c.caseId}: HARNESS ERROR — ${c.harnessError}`);
        continue;
      }
      const stageSummary = Object.values(c.stages).map((s) => `${s.stage}:${s.status}`).join(' ');
      lines.push(`case ${c.caseId}  [${stageSummary}]`);
      if (c.attribution !== undefined) lines.push(`    ${describeAttribution(c.attribution)}`);
      for (const s of Object.values(c.stages)) if (s.status === 'failed') lines.push(`    ${s.stage} FAILED: [${s.errorCode}] ${s.errorMessage}`);
      for (const m of c.metrics) {
        lines.push(metricLine(m));
        lines.push(...items('missing   ', m.missing, limit), ...items('unexpected', m.unexpected, limit), ...items('mismatched', m.mismatched, limit));
      }
    }
  }
  return lines.join('\n');
}

export function formatRegression(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push(`Regression comparison for suite "${report.suiteId}": ${report.classification.toUpperCase()}`);
  lines.push(`  compilation output changed: ${report.compilationOutputChanged ? 'yes' : 'no'}    execution output changed: ${report.executionOutputChanged ? 'yes' : 'no'}    execution-only regression: ${report.executionOnlyRegression ? 'YES' : 'no'}`);
  const section = (title: string, findings: readonly { readonly message: string; readonly attribution?: string }[]): void => {
    if (findings.length === 0) return;
    lines.push('', `${title} (${findings.length}):`);
    for (const f of findings) lines.push(`  - ${f.message}${f.attribution !== undefined ? ` [${f.attribution}]` : ''}`);
  };
  section('Regressions', report.regressions);
  section('Tradeoffs', report.tradeoffs);
  section('Improvements', report.improvements);
  section('Warnings', report.warnings);
  lines.push('', 'Aggregate metric changes:');
  for (const d of report.aggregate) {
    const fmt = (s: typeof d.before): string => (s === null || s.ratio === null ? 'n/a' : `${(s.ratio * 100).toFixed(1)}% (${s.numerator}/${s.denominator})`);
    lines.push(`  ${d.metricId.padEnd(30)} ${d.verdict.padEnd(10)} ${fmt(d.before)} -> ${fmt(d.after)}`);
  }
  return lines.join('\n');
}

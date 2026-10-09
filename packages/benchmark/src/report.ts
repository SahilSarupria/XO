import { EVALUATION_VERSION } from './attribution.js';
import type { BenchmarkSuiteDefinition } from './definition.js';
import { SUITE_SCHEMA_VERSION } from './definition.js';
import type { CaseEvaluation, ObservedSummary } from './evaluation-types.js';
import { evaluateCase } from './evaluate.js';
import { compareStrings, isPlainObject } from './json.js';
import { aggregateMetric, type MetricId, type MetricResult } from './metrics.js';
import { observeCase, type ObserveOptions } from './observe.js';

export const REPORT_SCHEMA_VERSION = 1 as const;

/** Metrics that describe the output without comparing it to any expectation. They never make an otherwise expectation-free suite count as "measured". */
export const DESCRIPTIVE_METRICS: ReadonlySet<MetricId> = new Set<MetricId>(['observedSourceRefCoverage', 'producerAttributionCoverage', 'provenanceChainCoverage', 'executionProvenanceAgreement', 'crossPathConsistency']);

export interface BenchmarkReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly suiteId: string;
  /** P0.9C Step 1: the attribution-model version that produced this report. Optional: reports written before it existed do not carry it. */
  readonly evaluationVersion?: string;
  readonly caseCount: number;
  readonly evaluatedCaseCount: number;
  /** Cases the HARNESS could not run (unreadable fixture, ...). Never silently counted as XO failures or passes. */
  readonly harnessErrorCount: number;
  /** True iff at least one EXPECTATION-based metric has a non-zero denominator. An empty / expectation-free suite is `false` — it measured nothing. */
  readonly measured: boolean;
  readonly aggregate: {
    readonly metrics: readonly MetricResult[];
    readonly observed: ObservedSummary;
  };
  /** Sorted by caseId — the order cases appear in the definition never affects the report. */
  readonly cases: readonly CaseEvaluation[];
}

function sumRecords(records: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
  return Object.fromEntries(Object.keys(out).sort(compareStrings).map((k) => [k, out[k]!]));
}

function aggregateObserved(cases: readonly CaseEvaluation[]): ObservedSummary {
  const evaluated = cases.filter((c) => c.status === 'evaluated');
  return {
    nodeCountsByKind: sumRecords(evaluated.map((c) => c.observed.nodeCountsByKind)),
    capabilities: {
      total: evaluated.reduce((n, c) => n + c.observed.capabilities.total, 0),
      byResolution: sumRecords(evaluated.map((c) => c.observed.capabilities.byResolution)),
      byExecutionClass: sumRecords(evaluated.map((c) => c.observed.capabilities.byExecutionClass)),
    },
    workflows: {
      total: evaluated.reduce((n, c) => n + c.observed.workflows.total, 0),
      totalSteps: evaluated.reduce((n, c) => n + c.observed.workflows.totalSteps, 0),
      byExecutability: sumRecords(evaluated.map((c) => c.observed.workflows.byExecutability)),
    },
    executions: { total: evaluated.reduce((n, c) => n + c.observed.executions.total, 0), byOutcome: sumRecords(evaluated.map((c) => c.observed.executions.byOutcome)) },
  };
}

export function buildReport(suiteId: string, evaluations: readonly CaseEvaluation[]): BenchmarkReport {
  const cases = [...evaluations].sort((a, b) => compareStrings(a.caseId, b.caseId));
  const byMetric = new Map<MetricId, { caseId: string; metric: MetricResult }[]>();
  for (const c of cases) {
    if (c.status !== 'evaluated') continue;
    for (const metric of c.metrics) byMetric.set(metric.id, [...(byMetric.get(metric.id) ?? []), { caseId: c.caseId, metric }]);
  }
  const metrics: MetricResult[] = [];
  for (const [id, perCase] of byMetric) {
    const agg = aggregateMetric(id, perCase);
    if (agg !== undefined) metrics.push(agg);
  }
  metrics.sort((a, b) => compareStrings(a.id, b.id));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suiteId,
    evaluationVersion: EVALUATION_VERSION,
    caseCount: cases.length,
    evaluatedCaseCount: cases.filter((c) => c.status === 'evaluated').length,
    harnessErrorCount: cases.filter((c) => c.status === 'harness_error').length,
    measured: metrics.some((m) => m.measured && !DESCRIPTIVE_METRICS.has(m.id)),
    aggregate: { metrics, observed: aggregateObserved(cases) },
    cases,
  };
}

/** Observes the REAL pipeline for every case, then evaluates. Cases are independent (no shared state), so the order they are processed in cannot influence any result. */
export async function runSuite(suite: BenchmarkSuiteDefinition, options: ObserveOptions): Promise<BenchmarkReport> {
  const evaluations: CaseEvaluation[] = [];
  for (const def of suite.cases) evaluations.push(evaluateCase(def, await observeCase(def, options)));
  return buildReport(suite.suiteId, evaluations);
}

/** Minimal structural validation of a previously written report (a baseline read back from disk). */
export function parseReport(raw: unknown): { readonly ok: true; readonly value: BenchmarkReport } | { readonly ok: false; readonly message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: 'report must be a JSON object' };
  if (raw['schemaVersion'] !== REPORT_SCHEMA_VERSION) return { ok: false, message: `unsupported report schemaVersion ${JSON.stringify(raw['schemaVersion'])} (expected ${REPORT_SCHEMA_VERSION})` };
  if (typeof raw['suiteId'] !== 'string') return { ok: false, message: 'report.suiteId must be a string' };
  if (!Array.isArray(raw['cases'])) return { ok: false, message: 'report.cases must be an array' };
  if (!isPlainObject(raw['aggregate']) || !Array.isArray((raw['aggregate'] as Record<string, unknown>)['metrics'])) return { ok: false, message: 'report.aggregate.metrics must be an array' };
  return { ok: true, value: raw as unknown as BenchmarkReport };
}

export { SUITE_SCHEMA_VERSION };

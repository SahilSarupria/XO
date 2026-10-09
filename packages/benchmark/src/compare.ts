import type { CaseEvaluation } from './evaluation-types.js';
import { compareStrings } from './json.js';
import type { MetricId, MetricItem, MetricResult } from './metrics.js';
import type { StageName } from './observation.js';
import type { BenchmarkReport } from './report.js';

/**
 * Regression comparison of two reports of the SAME suite (a recorded
 * baseline vs. a fresh run). It answers the two questions this layer
 * exists for, without blending them:
 *
 *   "improved recall but introduced semantic false positives"
 *        -> a `tradeoff` finding: one metric of a recall/precision pair
 *           went up while its partner went down, with the new
 *           unexpected items named.
 *   "a runtime change did not change semantic compilation but broke execution"
 *        -> per-case stage FINGERPRINTS (a stable hash of each stage's
 *           observable output) show compile/capability/workflow output
 *           unchanged while an execution metric regressed:
 *           `attribution: 'execution_only'`.
 *
 * Verdicts are item-aware, not just ratio-aware: a change that fixes one
 * item and breaks another leaves recall unchanged but is reported
 * `mixed`, never `unchanged`.
 */

export type MetricVerdict = 'improved' | 'regressed' | 'mixed' | 'unchanged';

export interface MetricSnapshot {
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio: number | null;
}

export interface MetricDelta {
  readonly metricId: MetricId;
  readonly stage: StageName;
  readonly caseId?: string;
  readonly before: MetricSnapshot | null;
  readonly after: MetricSnapshot | null;
  readonly verdict: MetricVerdict;
  /**
   * P0.9C Step 7: `added` = the metric exists only in the current report; `removed` = only in the baseline. A metric with no counterpart is never diffed against
   * nothing: a new metric is not a regression and a vanished one earns no improvement credit (both are surfaced as warnings instead).
   */
  readonly presence: 'both' | 'added' | 'removed';
  /** Items failing now that were not failing before (newly missing / unexpected / mismatched). */
  readonly newlyFailing: readonly string[];
  /** Items that were failing before and are not now. */
  readonly resolved: readonly string[];
  /** The denominator shrank: assertions that used to be evaluated no longer are (e.g. an upstream item vanished) — a measurement was LOST, which a ratio alone would hide. */
  readonly coverageReduced: boolean;
  readonly coverageIncreased: boolean;
}

export type Attribution = 'compilation' | 'execution_only' | 'downstream_of_compilation_change' | 'unattributed';

export interface Finding {
  readonly kind: 'metric_regression' | 'metric_improvement' | 'tradeoff' | 'coverage_reduced' | 'case_removed' | 'case_added' | 'harness_error' | 'configuration_changed' | 'metric_added' | 'metric_removed' | 'metric_definition_changed' | 'evaluation_version_changed';
  readonly metricId?: MetricId;
  readonly caseId?: string;
  readonly stage?: StageName;
  readonly attribution?: Attribution;
  readonly message: string;
}

export interface CaseComparison {
  readonly caseId: string;
  readonly presence: 'both' | 'added' | 'removed';
  /** Which stages' observable OUTPUT changed (fingerprint differs), independent of any expectation. */
  readonly stageOutputChanged: Readonly<Record<StageName, boolean>>;
  readonly metrics: readonly MetricDelta[];
}

export type RegressionClassification = 'no_change' | 'improved' | 'regressed' | 'mixed';

export interface RegressionReport {
  readonly suiteId: string;
  readonly classification: RegressionClassification;
  /** Any case's compile / capabilities / workflows stage output differs from the baseline. */
  readonly compilationOutputChanged: boolean;
  /** Any case's execution stage output differs from the baseline. */
  readonly executionOutputChanged: boolean;
  /** True iff execution metrics regressed while NO compile-side (compile/capabilities/workflows) metric regressed and no compile-side output changed in the affected case(s). */
  readonly executionOnlyRegression: boolean;
  readonly aggregate: readonly MetricDelta[];
  readonly cases: readonly CaseComparison[];
  readonly regressions: readonly Finding[];
  readonly improvements: readonly Finding[];
  readonly tradeoffs: readonly Finding[];
  readonly warnings: readonly Finding[];
}

const COMPILE_SIDE: ReadonlySet<StageName> = new Set<StageName>(['compile', 'capabilities', 'workflows']);
const PAIRS: readonly (readonly [MetricId, MetricId])[] = [
  ['semanticRecall', 'semanticPrecision'],
  ['capabilityRecall', 'capabilityPrecision'],
  ['workflowRecall', 'workflowPrecision'],
];

function snapshot(m: MetricResult | undefined): MetricSnapshot | null {
  return m === undefined ? null : { numerator: m.numerator, denominator: m.denominator, ratio: m.ratio };
}

function failingKeys(m: MetricResult | undefined): Set<string> {
  const keys = new Set<string>();
  if (m === undefined) return keys;
  for (const list of [m.missing, m.unexpected, m.mismatched]) for (const item of list as readonly MetricItem[]) keys.add(`${item.caseId ?? ''}|${item.id}`);
  return keys;
}

function diffMetric(id: MetricId, stage: StageName, before: MetricResult | undefined, after: MetricResult | undefined, caseId?: string): MetricDelta {
  const b = failingKeys(before);
  const a = failingKeys(after);
  const newlyFailing = [...a].filter((k) => !b.has(k)).sort(compareStrings);
  const resolved = [...b].filter((k) => !a.has(k)).sort(compareStrings);
  const beforeRatio = before?.ratio ?? null;
  const afterRatio = after?.ratio ?? null;
  const ratioUp = beforeRatio !== null && afterRatio !== null && afterRatio > beforeRatio;
  const ratioDown = beforeRatio !== null && afterRatio !== null && afterRatio < beforeRatio;
  const coverageReduced = (before?.denominator ?? 0) > (after?.denominator ?? 0);
  const coverageIncreased = (after?.denominator ?? 0) > (before?.denominator ?? 0);

  const presence: MetricDelta['presence'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'both';
  let verdict: MetricVerdict;
  if (presence !== 'both') verdict = 'unchanged';
  else if (ratioDown && !(resolved.length > 0 && newlyFailing.length === 0)) verdict = newlyFailing.length > 0 && resolved.length > 0 ? 'mixed' : 'regressed';
  else if (newlyFailing.length > 0 && (resolved.length > 0 || ratioUp)) verdict = 'mixed';
  else if (newlyFailing.length > 0) verdict = 'regressed';
  else if (ratioUp || resolved.length > 0) verdict = 'improved';
  else verdict = 'unchanged';

  return { metricId: id, stage, ...(caseId !== undefined ? { caseId } : {}), before: snapshot(before), after: snapshot(after), verdict, presence, newlyFailing: presence === 'both' ? newlyFailing : [], resolved: presence === 'both' ? resolved : [], coverageReduced, coverageIncreased };
}

function pct(s: MetricSnapshot | null): string {
  return s === null || s.ratio === null ? 'n/a' : `${(s.ratio * 100).toFixed(1)}% (${s.numerator}/${s.denominator})`;
}

function diffMetricSets(before: readonly MetricResult[], after: readonly MetricResult[], caseId?: string): MetricDelta[] {
  const ids = new Set<MetricId>([...before.map((m) => m.id), ...after.map((m) => m.id)]);
  const deltas: MetricDelta[] = [];
  for (const id of [...ids].sort(compareStrings)) {
    const b = before.find((m) => m.id === id);
    const a = after.find((m) => m.id === id);
    deltas.push(diffMetric(id, (a ?? b)!.stage, b, a, caseId));
  }
  return deltas;
}

export function compareReports(baseline: BenchmarkReport, current: BenchmarkReport): RegressionReport {
  const regressions: Finding[] = [];
  const improvements: Finding[] = [];
  const tradeoffs: Finding[] = [];
  const warnings: Finding[] = [];
  if (baseline.suiteId !== current.suiteId) warnings.push({ kind: 'harness_error', message: `comparing reports of different suites ("${baseline.suiteId}" vs "${current.suiteId}")` });

  // P0.9C Step 7: results from different evaluation versions are never compared silently (a missing version means the baseline predates versioning).
  if (baseline.evaluationVersion !== current.evaluationVersion) warnings.push({ kind: 'evaluation_version_changed', message: `evaluation version ${baseline.evaluationVersion ?? '(none: the baseline predates versioning)'} -> ${current.evaluationVersion ?? '(none)'}: results are not directly comparable without interpretation` });

  const baselineCases = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const currentCases = new Map(current.cases.map((c) => [c.caseId, c]));
  const caseIds = [...new Set([...baselineCases.keys(), ...currentCases.keys()])].sort(compareStrings);

  const cases: CaseComparison[] = [];
  let compilationOutputChanged = false;
  let executionOutputChanged = false;
  const noStageChange: Record<StageName, boolean> = { compile: false, capabilities: false, workflows: false, execution: false };

  for (const caseId of caseIds) {
    const b: CaseEvaluation | undefined = baselineCases.get(caseId);
    const c: CaseEvaluation | undefined = currentCases.get(caseId);
    if (b === undefined || c === undefined) {
      cases.push({ caseId, presence: b === undefined ? 'added' : 'removed', stageOutputChanged: noStageChange, metrics: [] });
      (b === undefined ? warnings : regressions).push({ kind: b === undefined ? 'case_added' : 'case_removed', caseId, message: b === undefined ? `case "${caseId}" is new (no baseline)` : `case "${caseId}" existed in the baseline but is not in the current run — its measurements are lost` });
      continue;
    }
    // P0.9C Step 1: never compare across configurations silently. Warning only — it changes neither any verdict nor the classification.
    if (b.attribution !== undefined && c.attribution !== undefined && b.attribution.configurationId !== c.attribution.configurationId) {
      warnings.push({ kind: 'configuration_changed', caseId, message: `case "${caseId}" was produced under a different configuration than its baseline (${b.attribution.configurationId} -> ${c.attribution.configurationId}); metric deltas may reflect the configuration, not the implementation` });
    }
    if (c.status === 'harness_error') warnings.push({ kind: 'harness_error', caseId, message: `case "${caseId}" could not be run by the harness: ${c.harnessError}` });
    const stageOutputChanged: Record<StageName, boolean> = {
      compile: b.fingerprints.compile !== c.fingerprints.compile,
      capabilities: b.fingerprints.capabilities !== c.fingerprints.capabilities,
      workflows: b.fingerprints.workflows !== c.fingerprints.workflows,
      execution: b.fingerprints.execution !== c.fingerprints.execution,
    };
    const compileSideChanged = stageOutputChanged.compile || stageOutputChanged.capabilities || stageOutputChanged.workflows;
    compilationOutputChanged ||= compileSideChanged;
    executionOutputChanged ||= stageOutputChanged.execution;

    const deltas = diffMetricSets(b.metrics, c.metrics, caseId);
    for (const m of c.metrics) {
      const was = b.metrics.find((x) => x.id === m.id);
      if (was !== undefined && was.definition !== m.definition) warnings.push({ kind: 'metric_definition_changed', metricId: m.id, caseId, stage: m.stage, message: `${caseId}: the definition of ${m.id} changed; its ratio is not comparable with the baseline's without an evaluation-version change` });
    }
    for (const d of deltas) {
      if (d.presence === 'added') warnings.push({ kind: 'metric_added', metricId: d.metricId, caseId, stage: d.stage, message: `${caseId}: ${d.metricId} is new (the baseline predates it); it now reads ${pct(d.after)} and is not compared with a baseline value` });
      if (d.presence === 'removed') warnings.push({ kind: 'metric_removed', metricId: d.metricId, caseId, stage: d.stage, message: `${caseId}: ${d.metricId} was ${pct(d.before)} in the baseline and is no longer reported; this is a lost measurement, not an improvement` });
      const attribution: Attribution = COMPILE_SIDE.has(d.stage) ? 'compilation' : compileSideChanged ? 'downstream_of_compilation_change' : 'execution_only';
      if (d.verdict === 'regressed' || d.verdict === 'mixed') {
        regressions.push({ kind: 'metric_regression', metricId: d.metricId, caseId, stage: d.stage, attribution, message: `${caseId}: ${d.metricId} ${d.verdict} ${pct(d.before)} -> ${pct(d.after)}${d.newlyFailing.length > 0 ? `; newly failing: ${d.newlyFailing.slice(0, 5).map((k) => k.split('|').pop()).join(', ')}${d.newlyFailing.length > 5 ? ', …' : ''}` : ''}` });
      } else if (d.verdict === 'improved') {
        improvements.push({ kind: 'metric_improvement', metricId: d.metricId, caseId, stage: d.stage, message: `${caseId}: ${d.metricId} improved ${pct(d.before)} -> ${pct(d.after)}` });
      }
      if (d.coverageReduced) warnings.push({ kind: 'coverage_reduced', metricId: d.metricId, caseId, stage: d.stage, message: `${caseId}: ${d.metricId} now evaluates ${d.after?.denominator ?? 0} assertion(s), down from ${d.before?.denominator ?? 0} — a measurement was lost (an upstream item may have disappeared)` });
    }
    cases.push({ caseId, presence: 'both', stageOutputChanged, metrics: deltas.filter((d) => d.verdict !== 'unchanged' || d.coverageReduced || d.coverageIncreased) });
  }

  const aggregate = diffMetricSets(baseline.aggregate.metrics, current.aggregate.metrics);
  for (const [recallId, precisionId] of PAIRS) {
    const r = aggregate.find((d) => d.metricId === recallId);
    const p = aggregate.find((d) => d.metricId === precisionId);
    if (r === undefined || p === undefined) continue;
    const both = (d: MetricDelta): { readonly b: number; readonly a: number } | undefined => (d.before?.ratio !== null && d.before?.ratio !== undefined && d.after?.ratio !== null && d.after?.ratio !== undefined ? { b: d.before.ratio, a: d.after.ratio } : undefined);
    const up = (d: MetricDelta): boolean => { const r = both(d); return r !== undefined && r.a > r.b; };
    const down = (d: MetricDelta): boolean => { const r = both(d); return r !== undefined && r.a < r.b; };
    if ((up(r) && down(p)) || (down(r) && up(p))) {
      const [gain, loss] = up(r) ? [r, p] : [p, r];
      tradeoffs.push({ kind: 'tradeoff', metricId: loss.metricId, stage: loss.stage, message: `${gain.metricId} improved ${pct(gain.before)} -> ${pct(gain.after)} but ${loss.metricId} regressed ${pct(loss.before)} -> ${pct(loss.after)}${loss.newlyFailing.length > 0 ? `; newly failing: ${loss.newlyFailing.slice(0, 5).map((k) => k.replace('|', ':')).join(', ')}${loss.newlyFailing.length > 5 ? ', …' : ''}` : ''}` });
    }
  }

  const compileSideRegression = regressions.some((f) => f.kind === 'metric_regression' && f.attribution === 'compilation');
  const executionOnlyRegression = !compileSideRegression && regressions.some((f) => f.kind === 'metric_regression' && f.attribution === 'execution_only');

  const anyRegression = regressions.length > 0 || tradeoffs.length > 0;
  const anyImprovement = improvements.length > 0;
  const classification: RegressionClassification = anyRegression && anyImprovement ? 'mixed' : anyRegression ? 'regressed' : anyImprovement ? 'improved' : 'no_change';

  return { suiteId: current.suiteId, classification, compilationOutputChanged, executionOutputChanged, executionOnlyRegression, aggregate, cases, regressions, improvements, tradeoffs, warnings };
}

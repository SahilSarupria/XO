import { createHash } from 'node:crypto';
import { compareReports } from './compare.js';
import { compareStrings, canonicalJson } from './json.js';
import type { MetricId } from './metrics.js';
import type { BenchmarkReport } from './report.js';
import type { StageName } from './observation.js';

/**
 * P0.9C Step 7 — BASELINE + REGRESSION PROTOCOL.
 *
 * A committed baseline is EVIDENCE OF A REVIEWED STATE, not a mechanism for making the current implementation look correct. This module is pure:
 * it never reads or writes a baseline, never regenerates anything and never decides that a regeneration is acceptable. It answers four questions:
 *
 *   1. What IS this baseline?             `BaselineManifestEntry` (identity + status + retained history), verified by `verifyManifestEntry`.
 *   2. Is a report reproducible?          `findRunSpecificFields` (no wall-clock / instance identity may reach a report).
 *   3. WHY does a candidate differ?       `classifyDifferences` (a deterministic procedure; every difference gets exactly one class).
 *   4. What follows?                      `assessCandidate` (never "no regression" merely because something was regenerated) and
 *                                         `validateRefreshRecord` (a refresh must account for every difference).
 *
 * GRAPH HASH POLICY. `XoirGraph.contentHash()` is an INSTANCE / PROVENANCE identity by design: `hashNode` documents that `createdAt` is "treated as part of a
 * node's provenance" and is hashed (while `updatedAt` and `reviewStatus` are not). Two compilations of an identical fixture therefore have different graph
 * hashes. No content-only graph identity exists and none is invented here. Consequently a graph hash is (a) never a key of a report, a fingerprint or a
 * baseline, (b) comparable only inside one graph instance and its serialized copies (provenance agreement, live <-> serialized), and (c) never evidence that two
 * independently compiled graphs differ semantically. The stable semantic identities the pipeline does provide are the content-derived capability id, the
 * `contractContentHash` and the binding id.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type BaselineStatus = 'historical' | 'accepted';

export type ChangeClass =
  | 'semantic_regression'
  | 'semantic_improvement'
  | 'expected_metric_addition'
  | 'golden_expectation_change'
  | 'configuration_change'
  | 'population_change'
  | 'evaluation_version_change'
  | 'representation_only'
  | 'known_historical_drift'
  | 'not_comparable';
export const CHANGE_CLASSES: readonly ChangeClass[] = ['semantic_regression', 'semantic_improvement', 'expected_metric_addition', 'golden_expectation_change', 'configuration_change', 'population_change', 'evaluation_version_change', 'representation_only', 'known_historical_drift', 'not_comparable'];

export type Direction = 'regression' | 'improvement' | 'neutral';

/** The step that introduced each non-historical metric. A metric id absent from a baseline and present here is an EXPECTED addition. */
export const METRIC_INTRODUCED_IN: Readonly<Partial<Record<MetricId, string>>> = {
  producerAttributionCoverage: 'P0.9C Step 4',
  producerAttributionCorrectness: 'P0.9C Step 4',
  provenanceChainCoverage: 'P0.9C Step 5',
  executionProvenanceAgreement: 'P0.9C Step 5',
  crossPathConsistency: 'P0.9C Step 6',
};

/** Keys that identify a run or an instance rather than semantic content. None may appear anywhere in a report. */
export const RUN_SPECIFIC_KEYS: readonly string[] = ['graphHash', 'createdAt', 'updatedAt', 'timestamp', 'generatedAt', 'runId', 'hostname', 'cwd', 'pid'];

/** Paths of every run-specific key (and every absolute filesystem path value) found anywhere in `value`. Empty = reproducible. */
export function findRunSpecificFields(value: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (typeof value === 'string' && /^(?:[A-Za-z]:\\|\/(?:home|tmp|Users|var|mnt)\/)/.test(value)) out.push(`${path} (absolute path)`);
  else if (Array.isArray(value)) value.forEach((v, i) => out.push(...findRunSpecificFields(v, `${path}[${i}]`)));
  else if (typeof value === 'object' && value !== null)
    for (const [k, v] of Object.entries(value)) {
      if (RUN_SPECIFIC_KEYS.includes(k)) out.push(`${path}.${k}`);
      out.push(...findRunSpecificFields(v, `${path}.${k}`));
    }
  return out.sort(compareStrings);
}

// ---------------------------------------------------------------------------
// Baseline manifest (identity + retained history)
// ---------------------------------------------------------------------------

export interface BaselineFixture { readonly path: string; readonly sha256: string }

export interface BaselineCaseIdentity {
  readonly caseId: string;
  /** The Step 1 configuration id recorded in the baseline, or `null` when the baseline predates configuration attribution. */
  readonly configurationId: string | null;
  readonly fixtures: readonly BaselineFixture[];
  /** `expectationsFingerprint` (Step 3) of the golden state this baseline was produced under, or `null` when that state is unrecoverable (see `goldenState`). */
  readonly expectationsFingerprint: string | null;
  readonly goldenState: 'recorded' | 'unrecoverable';
}

export interface KnownDrift {
  readonly caseId: string;
  readonly metricId?: MetricId;
  /** a stage whose observable OUTPUT (fingerprint) changed */
  readonly stage?: StageName;
  readonly reason: string;
  readonly evidence: string;
}

/**
 * P0.9C closure (Decision C): a FUTURE, explicitly declared change of the evaluated population classifies as `population_change`, never as
 * `known_historical_drift`. Same shape and the same STRICT matching as `KnownDrift`; historical `knownDrift` records are not rewritten.
 */
export type DeclaredPopulationChange = KnownDrift;

export interface DeclaredGoldenChange {
  readonly caseId: string;
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly reason: string;
  readonly evidence: string;
  readonly affectedMetrics: readonly string[];
  /** where the change was reviewed and accepted (a CHANGELOG entry) */
  readonly acceptedAt: string;
}

export interface BaselineManifestEntry {
  readonly suiteId: string;
  readonly reportFile: string;
  /** sha256 of the committed report file's bytes: a regenerated baseline cannot keep this value */
  readonly reportSha256: string;
  readonly evaluationVersion: string | null;
  readonly status: BaselineStatus;
  readonly metricIds: readonly string[];
  /** sha256 of the canonical `{metricId: definition}` map: identifies the metric semantics the baseline was produced under */
  readonly metricDefinitionsSha256: string;
  readonly cases: readonly BaselineCaseIdentity[];
  readonly knownDrift: readonly KnownDrift[];
  readonly declaredGoldenChanges: readonly DeclaredGoldenChange[];
  /** declared evaluated-population changes (classified `population_change`); optional, absent on historical entries */
  readonly declaredPopulationChanges?: readonly DeclaredPopulationChange[];
  /** the validated refresh record that produced this accepted baseline */
  readonly refreshRecord?: string;
  /** the baseline this one replaced (retained, never deleted), if any */
  readonly predecessor?: string;
  /** retained history: every event that touched this baseline, in order */
  readonly history: readonly { readonly step: string; readonly note: string }[];
}

export interface BaselineManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly BaselineManifestEntry[];
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function metricDefinitionsOf(report: BenchmarkReport): Record<string, string> {
  const defs: Record<string, string> = {};
  for (const m of [...report.aggregate.metrics, ...report.cases.flatMap((c) => c.metrics)]) defs[m.id] = m.definition;
  return Object.fromEntries(Object.entries(defs).sort(([a], [b]) => compareStrings(a, b)));
}

export type ManifestFindingCode = 'report_bytes_changed' | 'suite_mismatch' | 'evaluation_version_mismatch' | 'metric_set_mismatch' | 'metric_definitions_mismatch' | 'case_set_mismatch' | 'configuration_mismatch' | 'run_specific_field';
export interface ManifestFinding { readonly code: ManifestFindingCode; readonly message: string }

/** Does this report, with these bytes, still BE the baseline the manifest describes? A regenerated baseline fails until its manifest entry is updated by a refresh record. */
export function verifyManifestEntry(entry: BaselineManifestEntry, report: BenchmarkReport, reportBytes: string | Uint8Array): readonly ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const add = (code: ManifestFindingCode, message: string): void => void out.push({ code, message });
  if (sha256Hex(reportBytes) !== entry.reportSha256) add('report_bytes_changed', `${entry.reportFile} no longer has the recorded sha256; a baseline may only change through a refresh record (see BASELINE_PROTOCOL.md)`);
  if (report.suiteId !== entry.suiteId) add('suite_mismatch', `report is for "${report.suiteId}", manifest entry is for "${entry.suiteId}"`);
  if ((report.evaluationVersion ?? null) !== entry.evaluationVersion) add('evaluation_version_mismatch', `report ${report.evaluationVersion ?? '(none)'} vs manifest ${entry.evaluationVersion ?? '(none)'}`);
  const defs = metricDefinitionsOf(report);
  if (JSON.stringify(Object.keys(defs)) !== JSON.stringify([...entry.metricIds].sort(compareStrings))) add('metric_set_mismatch', `metric ids ${JSON.stringify(Object.keys(defs))} vs ${JSON.stringify(entry.metricIds)}`);
  if (sha256Hex(canonicalJson(defs)) !== entry.metricDefinitionsSha256) add('metric_definitions_mismatch', 'the metric definitions differ from those the baseline was produced under');
  if (JSON.stringify(report.cases.map((c) => c.caseId)) !== JSON.stringify(entry.cases.map((c) => c.caseId).sort(compareStrings))) add('case_set_mismatch', 'the case population differs from the manifest');
  for (const c of report.cases) {
    const id = entry.cases.find((x) => x.caseId === c.caseId);
    if (id !== undefined && (c.attribution?.configurationId ?? null) !== id.configurationId) add('configuration_mismatch', `${c.caseId}: configuration id differs from the manifest`);
  }
  for (const f of findRunSpecificFields(report)) add('run_specific_field', `report contains the run-specific field ${f}`);
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassificationContext {
  readonly knownDrift?: readonly KnownDrift[];
  readonly declaredPopulationChanges?: readonly DeclaredPopulationChange[];
  readonly declaredGoldenChanges?: readonly DeclaredGoldenChange[];
  /** `expectationsFingerprint` of each case in the CURRENT suite */
  readonly currentExpectations?: Readonly<Record<string, string>>;
  /** the golden state each baseline case was produced under, where recorded (from the manifest) */
  readonly baselineExpectations?: Readonly<Record<string, string | null>>;
}

export interface ClassifiedDifference {
  readonly id: string;
  readonly class: ChangeClass;
  readonly direction: Direction;
  readonly caseId?: string;
  readonly metricId?: string;
  readonly detail: string;
  /** For explained classes: the declared reason / evidence. */
  readonly basis?: string;
}

export type CandidateDecision = 'identical' | 'compatible' | 'review_required' | 'regression' | 'not_comparable';

export interface BaselineAssessment {
  readonly suiteId: string;
  readonly differences: readonly ClassifiedDifference[];
  readonly counts: Readonly<Record<ChangeClass, number>>;
  /**
   * identical         nothing differs
   * compatible        the only differences are expected metric additions and representation-only metadata: the baseline is still valid evidence
   * review_required   every difference is explained, but a human must review before anything is refreshed
   * regression        at least one UNEXPLAINED regression (or lost measurement)
   * not_comparable    at least one difference makes the pair not directly comparable (different suite, undeclared metric / definition / golden change, harness error)
   * There is no "no regression" outcome for a regenerated baseline: only `identical` and `compatible` carry no review obligation.
   */
  readonly decision: CandidateDecision;
}

/**
 * The decision procedure. For every difference it asks, in this order (first match wins): was the suite different? the evaluation version? the metric definition?
 * the configuration? the golden expectation? a declared historical drift? Only a difference nothing declares is a `semantic_*` change.
 */
export function classifyDifferences(baseline: BenchmarkReport, current: BenchmarkReport, ctx: ClassificationContext = {}): BaselineAssessment {
  const cmp = compareReports(baseline, current);
  const diffs: ClassifiedDifference[] = [];
  const add = (d: ClassifiedDifference): void => void diffs.push(d);
  const versionChanged = (baseline.evaluationVersion ?? null) !== (current.evaluationVersion ?? null);

  if (baseline.suiteId !== current.suiteId) add({ id: 'suite', class: 'not_comparable', direction: 'neutral', detail: `suites "${baseline.suiteId}" and "${current.suiteId}" are different suites` });
  if (versionChanged) add({ id: 'evaluation_version', class: 'evaluation_version_change', direction: 'neutral', detail: baseline.evaluationVersion === undefined ? `the baseline predates evaluation versioning (current: ${current.evaluationVersion})` : `evaluation version ${baseline.evaluationVersion} -> ${current.evaluationVersion}` });

  // STRICT matching: a declared drift explains only what it names. Nothing is explained by a broader entry.
  const driftForCase = (caseId: string): KnownDrift | undefined => (ctx.knownDrift ?? []).find((k) => k.caseId === caseId && k.metricId === undefined && k.stage === undefined);
  const driftForMetric = (caseId: string, metricId: string): KnownDrift | undefined => (ctx.knownDrift ?? []).find((k) => k.caseId === caseId && k.metricId === metricId);
  const driftForStage = (caseId: string, stage: StageName): KnownDrift | undefined => (ctx.knownDrift ?? []).find((k) => k.caseId === caseId && k.stage === stage);

  const popForMetric = (caseId: string, metricId: string): DeclaredPopulationChange | undefined => (ctx.declaredPopulationChanges ?? []).find((k) => k.caseId === caseId && k.metricId === metricId);
  const popForStage = (caseId: string, stage: StageName): DeclaredPopulationChange | undefined => (ctx.declaredPopulationChanges ?? []).find((k) => k.caseId === caseId && k.stage === stage);

  const baselineCases = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const goldenChanged = new Set<string>();
  for (const caseId of [...new Set([...baselineCases.keys(), ...current.cases.map((c) => c.caseId)])].sort(compareStrings)) {
    const b = baselineCases.get(caseId);
    const c = current.cases.find((x) => x.caseId === caseId);
    if (b === undefined) { add({ id: `case|${caseId}`, class: 'population_change', direction: 'neutral', caseId, detail: `case "${caseId}" is new: the evaluated population grew` }); continue; }
    if (c === undefined) {
      const k = driftForCase(caseId);
      add(k ? { id: `case|${caseId}`, class: 'known_historical_drift', direction: 'neutral', caseId, detail: `case "${caseId}" no longer exists`, basis: `${k.reason} (${k.evidence})` } : { id: `case|${caseId}`, class: 'semantic_regression', direction: 'regression', caseId, detail: `case "${caseId}" disappeared: its measurements are lost` });
      continue;
    }
    if (c.status === 'harness_error') add({ id: `harness|${caseId}`, class: 'not_comparable', direction: 'neutral', caseId, detail: `case "${caseId}" could not be run by the harness` });

    // golden expectation state
    const nowFp = ctx.currentExpectations?.[caseId];
    const thenFp = ctx.baselineExpectations?.[caseId];
    const declared = (ctx.declaredGoldenChanges ?? []).find((g) => g.caseId === caseId && (nowFp === undefined || g.toFingerprint === nowFp));
    if (declared !== undefined) { goldenChanged.add(caseId); add({ id: `golden|${caseId}`, class: 'golden_expectation_change', direction: 'neutral', caseId, detail: `golden expectations changed (${declared.fromFingerprint} -> ${declared.toFingerprint}); affected metrics: ${declared.affectedMetrics.join(', ') || 'none'}`, basis: `${declared.reason} (${declared.evidence}); accepted at ${declared.acceptedAt}` }); }
    else if (nowFp !== undefined && thenFp !== undefined && thenFp !== null && thenFp !== nowFp) add({ id: `golden|${caseId}`, class: 'not_comparable', direction: 'neutral', caseId, detail: `golden expectations changed (${thenFp} -> ${nowFp}) with NO declared, reviewed change: the pair is not comparable` });

    // configuration
    if (b.attribution === undefined && c.attribution !== undefined) add({ id: `attribution|${caseId}`, class: 'representation_only', direction: 'neutral', caseId, detail: 'the baseline predates attribution metadata (descriptive; it feeds no metric)' });
    else if (b.attribution !== undefined && c.attribution !== undefined && b.attribution.configurationId !== c.attribution.configurationId) add({ id: `configuration|${caseId}`, class: 'configuration_change', direction: 'neutral', caseId, detail: `configuration ${b.attribution.configurationId} -> ${c.attribution.configurationId}: results are not directly comparable without interpretation` });
    const configChanged = b.attribution !== undefined && c.attribution !== undefined && b.attribution.configurationId !== c.attribution.configurationId;

    // metric definitions
    for (const m of c.metrics) {
      const was = b.metrics.find((x) => x.id === m.id);
      if (was !== undefined && was.definition !== m.definition) add({ id: `definition|${caseId}|${m.id}`, class: versionChanged ? 'evaluation_version_change' : 'not_comparable', direction: 'neutral', caseId, metricId: m.id, detail: versionChanged ? `${m.id}: definition changed together with the evaluation version` : `${m.id}: definition changed WITHOUT an evaluation-version change (undeclared)` });
    }

    // metrics
    const comparison = cmp.cases.find((x) => x.caseId === caseId);
    for (const d of comparison?.metrics ?? []) {
      const kd = driftForMetric(caseId, d.metricId);
      const pc = popForMetric(caseId, d.metricId);
      const explained = (cls: ChangeClass, direction: Direction, detail: string, basis?: string): void => add({ id: `metric|${caseId}|${d.metricId}`, class: cls, direction, caseId, metricId: d.metricId, detail, ...(basis ? { basis } : {}) });
      if (d.presence === 'added') { METRIC_INTRODUCED_IN[d.metricId] !== undefined ? explained('expected_metric_addition', 'neutral', `${d.metricId} was introduced by ${METRIC_INTRODUCED_IN[d.metricId]}; the baseline predates it (absent, not zero)`) : explained('not_comparable', 'neutral', `${d.metricId} is not a registered metric addition`); continue; }
      if (d.presence === 'removed') { explained(versionChanged ? 'evaluation_version_change' : 'semantic_regression', versionChanged ? 'neutral' : 'regression', versionChanged ? `${d.metricId} is no longer reported (evaluation version changed)` : `${d.metricId} was reported by the baseline and is no longer reported: a measurement was lost`); continue; }
      const direction: Direction = d.verdict === 'regressed' || d.verdict === 'mixed' ? 'regression' : d.verdict === 'improved' ? 'improvement' : d.coverageReduced && d.newlyFailing.length === 0 ? 'regression' : 'neutral';
      const what = `${d.metricId} ${d.verdict}${d.coverageReduced ? ', coverage reduced' : ''}${d.coverageIncreased ? ', coverage increased' : ''}`;
      if (goldenChanged.has(caseId) && ctx.declaredGoldenChanges?.some((g) => g.caseId === caseId && (g.affectedMetrics.length === 0 || g.affectedMetrics.includes(d.metricId)))) explained('golden_expectation_change', direction, what, 'a declared golden change lists this metric');
      else if (configChanged) explained('configuration_change', direction, what);
      else if (pc !== undefined) explained('population_change', direction, what, `${pc.reason} (${pc.evidence})`);
      else if (kd !== undefined) explained('known_historical_drift', direction, what, `${kd.reason} (${kd.evidence})`);
      else if (direction === 'regression') explained('semantic_regression', 'regression', what + (d.coverageReduced && d.verdict === 'unchanged' ? ' (genuine coverage loss: no declared population change)' : ''));
      else if (direction === 'improvement') explained('semantic_improvement', 'improvement', what);
      else explained('population_change', 'neutral', what + ': the evaluated population changed (no metric failure)');
    }

    // observable output changed (stage fingerprints), independent of any metric
    for (const stage of ['compile', 'capabilities', 'workflows', 'execution'] as const) {
      if (!comparison?.stageOutputChanged[stage]) continue;
      const k = driftForStage(caseId, stage);
      if (configChanged) { add({ id: `output|${caseId}|${stage}`, class: 'configuration_change', direction: 'neutral', caseId, detail: `${stage} output changed under a different configuration (not directly comparable)` }); continue; }
      const pcs = popForStage(caseId, stage);
      if (pcs !== undefined) { add({ id: `output|${caseId}|${stage}`, class: 'population_change', direction: 'neutral', caseId, detail: `${stage} output changed`, basis: `${pcs.reason} (${pcs.evidence})` }); continue; }
      add(k ? { id: `output|${caseId}|${stage}`, class: 'known_historical_drift', direction: 'neutral', caseId, detail: `${stage} output changed`, basis: `${k.reason} (${k.evidence})` } : { id: `output|${caseId}|${stage}`, class: 'semantic_regression', direction: 'neutral', caseId, detail: `${stage} output changed with no declared cause (no metric may have moved): review required` });
    }
  }

  diffs.sort((a, b) => compareStrings(a.id, b.id));
  const counts = Object.fromEntries(CHANGE_CLASSES.map((c) => [c, diffs.filter((d) => d.class === c).length])) as Record<ChangeClass, number>;
  const unexplainedRegression = diffs.some((d) => d.class === 'semantic_regression' && d.direction === 'regression');
  const decision: CandidateDecision =
    diffs.length === 0 ? 'identical'
    : diffs.some((d) => d.class === 'not_comparable') ? 'not_comparable'
    : unexplainedRegression ? 'regression'
    : diffs.every((d) => d.class === 'expected_metric_addition' || d.class === 'representation_only') ? 'compatible'
    : 'review_required';
  return { suiteId: current.suiteId, differences: diffs, counts, decision };
}

// ---------------------------------------------------------------------------
// Refresh record
// ---------------------------------------------------------------------------

export interface RefreshDisposition { readonly differenceId: string; readonly disposition: 'accepted' | 'acknowledged_regression'; readonly reason: string }

export interface BaselineRefreshRecord {
  readonly suiteId: string;
  readonly fromReportSha256: string;
  readonly toReportSha256: string;
  readonly evaluationVersion: { readonly from: string | null; readonly to: string };
  readonly reason: string;
  /** reviewer-chosen resolution for EVERY difference of the assessment */
  readonly dispositions: readonly RefreshDisposition[];
  readonly declaredGoldenChanges: readonly DeclaredGoldenChange[];
  /** a CHANGELOG entry / review reference; required */
  readonly acceptedAt: string;
  readonly predecessorRetainedAs: string;
}

/** A refresh is valid only if it accounts for every difference, records every golden change, names its predecessor and says where it was accepted. */
export function validateRefreshRecord(record: BaselineRefreshRecord, assessment: BaselineAssessment): readonly string[] {
  const problems: string[] = [];
  if (assessment.decision === 'identical') problems.push('nothing differs: there is nothing to refresh');
  if (assessment.decision === 'not_comparable') problems.push('the pair is not comparable: resolve the not_comparable differences (declare the change, bump the evaluation version) before refreshing');
  if (record.reason.trim() === '') problems.push('a refresh needs a reason');
  if (record.acceptedAt.trim() === '') problems.push('a refresh needs an acceptance point (CHANGELOG entry or review reference)');
  if (record.predecessorRetainedAs.trim() === '') problems.push('the predecessor baseline must be retained (archived path or version), never deleted');
  if (record.toReportSha256 === record.fromReportSha256) problems.push('the refreshed report has the same sha256 as the baseline');
  const by = new Map(record.dispositions.map((d) => [d.differenceId, d] as const));
  for (const d of assessment.differences) {
    const disp = by.get(d.id);
    if (disp === undefined) { problems.push(`difference ${d.id} (${d.class}) has no disposition`); continue; }
    if (disp.reason.trim() === '') problems.push(`difference ${d.id} has an empty reason`);
    if (d.class === 'semantic_regression' && d.direction === 'regression' && disp.disposition !== 'acknowledged_regression') problems.push(`difference ${d.id} is an unexplained regression: it can only be recorded as "acknowledged_regression", never as an ordinary update`);
    if (d.class === 'golden_expectation_change' && !record.declaredGoldenChanges.some((g) => g.caseId === d.caseId)) problems.push(`golden change for ${d.caseId} is not recorded in the refresh record`);
  }
  for (const k of record.dispositions) if (!assessment.differences.some((d) => d.id === k.differenceId)) problems.push(`disposition for unknown difference ${k.differenceId}`);
  for (const g of record.declaredGoldenChanges) for (const f of ['reason', 'evidence', 'acceptedAt'] as const) if (g[f].trim() === '') problems.push(`golden change for ${g.caseId} has an empty ${f}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Manifest parser (strict)
// ---------------------------------------------------------------------------

export function parseBaselineManifest(raw: unknown): { readonly ok: true; readonly value: BaselineManifest } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const o = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const str = (v: unknown, p: string): void => { if (typeof v !== 'string' || v.trim() === '') issues.push(`${p}: must be a non-empty string`); };
  const known = (v: Record<string, unknown>, p: string, keys: readonly string[]): void => { for (const k of Object.keys(v)) if (!keys.includes(k)) issues.push(`${p}.${k}: unknown field`); };
  if (!o(raw)) return { ok: false, issues: ['$: must be an object'] };
  known(raw, '$', ['schemaVersion', 'entries']);
  if (raw['schemaVersion'] !== 1) issues.push('$.schemaVersion: must be 1');
  if (!Array.isArray(raw['entries'])) issues.push('$.entries: must be an array');
  else
    raw['entries'].forEach((e, i) => {
      const p = `$.entries[${i}]`;
      if (!o(e)) { issues.push(`${p}: must be an object`); return; }
      known(e, p, ['suiteId', 'reportFile', 'reportSha256', 'evaluationVersion', 'status', 'metricIds', 'metricDefinitionsSha256', 'cases', 'knownDrift', 'declaredGoldenChanges', 'declaredPopulationChanges', 'refreshRecord', 'predecessor', 'history']);
      for (const f of ['suiteId', 'reportFile', 'reportSha256', 'metricDefinitionsSha256']) str(e[f], `${p}.${f}`);
      if (typeof e['reportSha256'] === 'string' && !/^[0-9a-f]{64}$/.test(e['reportSha256'])) issues.push(`${p}.reportSha256: must be 64 hex characters`);
      if (e['evaluationVersion'] !== null && typeof e['evaluationVersion'] !== 'string') issues.push(`${p}.evaluationVersion: string or null`);
      if (e['status'] !== 'historical' && e['status'] !== 'accepted') issues.push(`${p}.status: historical | accepted`);
      for (const f of ['metricIds', 'cases', 'knownDrift', 'declaredGoldenChanges', 'history']) if (!Array.isArray(e[f])) issues.push(`${p}.${f}: must be an array`);
      if (Array.isArray(e['cases'])) e['cases'].forEach((c, j) => { if (!o(c)) return void issues.push(`${p}.cases[${j}]: object`); known(c, `${p}.cases[${j}]`, ['caseId', 'configurationId', 'fixtures', 'expectationsFingerprint', 'goldenState']); str(c['caseId'], `${p}.cases[${j}].caseId`); if (c['goldenState'] !== 'recorded' && c['goldenState'] !== 'unrecoverable') issues.push(`${p}.cases[${j}].goldenState: recorded | unrecoverable`); if (c['goldenState'] === 'recorded' && typeof c['expectationsFingerprint'] !== 'string') issues.push(`${p}.cases[${j}]: a recorded golden state needs a fingerprint`); if (c['goldenState'] === 'unrecoverable' && c['expectationsFingerprint'] !== null) issues.push(`${p}.cases[${j}]: an unrecoverable golden state must have a null fingerprint (nothing is invented)`); });
      if (e['declaredPopulationChanges'] !== undefined) { if (!Array.isArray(e['declaredPopulationChanges'])) issues.push(`${p}.declaredPopulationChanges: must be an array`); else e['declaredPopulationChanges'].forEach((k, j) => { if (!o(k)) return void issues.push(`${p}.declaredPopulationChanges[${j}]: object`); known(k, `${p}.declaredPopulationChanges[${j}]`, ['caseId', 'metricId', 'stage', 'reason', 'evidence']); for (const f of ['caseId', 'reason', 'evidence']) str(k[f], `${p}.declaredPopulationChanges[${j}].${f}`); }); }
      if (Array.isArray(e['knownDrift'])) e['knownDrift'].forEach((k, j) => { if (!o(k)) return void issues.push(`${p}.knownDrift[${j}]: object`); known(k, `${p}.knownDrift[${j}]`, ['caseId', 'metricId', 'stage', 'reason', 'evidence']); for (const f of ['caseId', 'reason', 'evidence']) str(k[f], `${p}.knownDrift[${j}].${f}`); });
    });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: raw as unknown as BaselineManifest };
}

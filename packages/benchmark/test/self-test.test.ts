import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  canonicalJson,
  classifyDifferences,
  compareReports,
  evalAll,
  evaluateCase,
  loadSuiteFile,
  matchesName,
  observeCase,
  type BenchmarkCaseDefinition,
  type BenchmarkReport,
  type CaseEvaluation,
  type MetricId,
  type PipelineObservation,
} from '../src/index.js';

/**
 * P0.9C Step 8 — TEST THE EVALUATION ITSELF.
 *
 * A mutation is a deliberately injected change to an observation, a definition or a report that represents a known defect. Each one is applied to a CLONE of
 * a real observation (never to production code), pushed through evaluateCase -> buildReport -> compareReports -> classifyDifferences, and must be (a) DETECTED by
 * the metric it targets, (b) classified, or (c) explicitly recorded as not_observable / not_applicable. Never counted as detected unless a number moved.
 *
 * "Survived the tested mutations" is the claim — NOT "proven correct".
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Status = 'detected' | 'not_detected' | 'not_observable' | 'not_applicable';
interface Row { mutation: string; target: string; description: string; expected: string; actual: string; status: Status; classification: string; ok: boolean }
const MATRIX: Row[] = [];

// ---- real fixtures (observed ONCE; every mutation works on a clone) ------------------------------

async function observe(suite: string, caseId: string): Promise<{ def: BenchmarkCaseDefinition; obs: PipelineObservation }> {
  const l = await loadSuiteFile(join(PKG, 'suites', `${suite}.suite.json`));
  assert.ok(l.ok);
  const def = l.suite.cases.find((c) => c.caseId === caseId)!;
  return { def, obs: await observeCase(def, { sourceRoot: l.sourceRoot }) };
}
const SYN = await observe('vertical-fixtures', 'synthetic-claim-rules');
const STR = await observe('vertical-fixtures', 'structured-operation-data-flow');
const COM = await observe('vertical-fixtures', 'commercial-property-policy');
const RUN = await observe('runtime-mechanics', 'runtime-mechanics');
type Fixture = typeof SYN;

const metric = (ev: CaseEvaluation, id: MetricId) => ev.metrics.find((m) => m.id === id);
const ratioOf = (ev: CaseEvaluation, id: MetricId): string => { const m = metric(ev, id); return m === undefined ? 'absent' : `${m.numerator}/${m.denominator}`; };
const reportOf = (ev: CaseEvaluation): BenchmarkReport => buildReport('self-test', [ev]);

interface Spec {
  id: string;
  target: string;
  description: string;
  fixture: Fixture;
  /** mutate the clones in place */
  apply: (obs: PipelineObservation & Record<string, any>, def: BenchmarkCaseDefinition & Record<string, any>) => void;
  /** a def mutation applied to BOTH the base and the mutated evaluation (a fixture change, not the defect) */
  prepare?: (def: BenchmarkCaseDefinition & Record<string, any>) => void;
  metric: MetricId;
  expect: 'decrease' | 'increase' | 'unchanged';
  /** additional exact assertions on (base, mutated) evaluations */
  check?: (base: CaseEvaluation, mut: CaseEvaluation) => void;
  /** when the mutation is a permitted/unobservable one, say which */
  observability?: 'not_observable' | 'not_applicable';
  /** a degrading mutation must also be flagged by the report comparator and the baseline protocol */
  pipeline?: boolean;
}

function run(spec: Spec): Row {
  const def0 = clone(spec.fixture.def) as BenchmarkCaseDefinition & Record<string, any>;
  spec.prepare?.(def0);
  const obs = clone(spec.fixture.obs) as PipelineObservation & Record<string, any>;
  const def1 = clone(def0);
  const mutObs = clone(obs);
  spec.apply(mutObs, def1);
  const base = evaluateCase(def0, obs);
  const mut = evaluateCase(def1, mutObs);
  const b = metric(base, spec.metric), m = metric(mut, spec.metric);
  const baseline = `${ratioOf(base, spec.metric)}`, actual = `${ratioOf(mut, spec.metric)}`;
  const rb = b?.ratio ?? null, rm = m?.ratio ?? null;
  let moved = false, direction: 'decrease' | 'increase' | 'unchanged' = 'unchanged';
  if (rb !== null && rm !== null) { if (rm < rb) { moved = true; direction = 'decrease'; } else if (rm > rb) { moved = true; direction = 'increase'; } }
  else if (b === undefined && m !== undefined) { moved = true; direction = 'increase'; }
  else if (b !== undefined && m === undefined) { moved = true; direction = 'decrease'; }
  let pipelineOk = true, classification = '-';
  if (spec.pipeline) {
    const cmp = compareReports(reportOf(base), reportOf(mut));
    const assessment = classifyDifferences(reportOf(base), reportOf(mut));
    classification = `${cmp.classification}/${assessment.decision}`;
    pipelineOk = (cmp.classification === 'regressed' || cmp.classification === 'mixed') && assessment.decision === 'regression';
  }
  const ok = direction === spec.expect && (spec.expect === 'unchanged' ? !moved : moved) && pipelineOk;
  spec.check?.(base, mut);
  const status: Status = spec.observability ?? (ok ? 'detected' : 'not_detected');
  const row: Row = { mutation: spec.id, target: spec.target, description: spec.description, expected: `${spec.metric} ${spec.expect}`, actual: `${spec.metric} ${baseline} -> ${actual}${spec.pipeline ? ` | report ${classification}` : ''}`, status, classification, ok };
  MATRIX.push(row);
  assert.ok(ok, `${spec.id}: expected ${spec.metric} ${spec.expect}, got ${baseline} -> ${actual}${spec.pipeline ? ` (pipeline ${classification})` : ''}`);
  return row;
}

// ---- selectors over real data ------------------------------------------------------------------------

const capByName = (obs: PipelineObservation, name: string) => obs.capabilities.findIndex((c) => c.name === name);
const firstExpectedFound = (f: Fixture, pick: (k: any) => boolean = () => true) => {
  for (const k of f.def.expect.capabilities?.items ?? []) if (pick(k)) { const i = f.obs.capabilities.findIndex((c) => matchesName(c.name, k.name)); if (i >= 0) return { k, i }; }
  throw new Error('no found expected capability');
};

// ---- 1-4: capabilities and facts ----------------------------------------------------------------------

test('M01 capability recall: removing exactly one expected capability from the candidate lowers recall and reports it missing', () => {
  const r = run({ id: 'M01', target: 'capabilities / recall', description: 'remove expected capability "Claim Assessment"', fixture: SYN, metric: 'capabilityRecall', expect: 'decrease', pipeline: true,
    apply: (o) => { o.capabilities.splice(capByName(o, 'Claim Assessment'), 1); },
    check: (_b, m) => assert.deepEqual(metric(m, 'capabilityRecall')!.missing.map((i) => i.id), ['cap-claim-assessment']) });
  assert.equal(r.status, 'detected');
});

test('M02 spurious capability (closed world): an unexpected capability lowers precision, leaves recall untouched, and is listed as unexpected', () => {
  run({ id: 'M02', target: 'capabilities / precision', description: 'inject capability "Totally Unrelated Task" into a closed-world case', fixture: SYN, metric: 'capabilityPrecision', expect: 'decrease', pipeline: true,
    apply: (o) => { o.capabilities.push({ ...clone(o.capabilities[0]!), capabilityId: 'cap_injected', name: 'Totally Unrelated Task' }); },
    check: (b, m) => { assert.equal(ratioOf(m, 'capabilityRecall'), ratioOf(b, 'capabilityRecall')); assert.deepEqual(metric(m, 'capabilityPrecision')!.unexpected.map((i) => i.id), ['capability|totally unrelated task']); } });
});

test('M02b forbidden capability: a trap injected into the candidate lowers spuriousCapabilityAvoidance', () => {
  run({ id: 'M02b', target: 'capabilities / forbidden', description: 'add forbidden "Schedule Action" to the definition, then inject it', fixture: SYN, metric: 'spuriousCapabilityAvoidance', expect: 'decrease', pipeline: true,
    prepare: (d) => { d.expect.capabilities.forbidden = [{ id: 'x-trap', name: { equals: 'Schedule Action' }, reason: 'self-test trap' }]; },
    apply: (o) => { o.capabilities.push({ ...clone(o.capabilities[0]!), capabilityId: 'cap_trap', name: 'Schedule Action' }); } });
});

test('M02c open world is respected: a permitted extra capability in an OPEN-world case moves no metric (not_applicable, never counted as detected)', () => {
  const r = run({ id: 'M02c', target: 'capabilities / open world', description: 'inject an unlisted capability into the open-world commercial case', fixture: COM, metric: 'capabilityRecall', expect: 'unchanged', observability: 'not_applicable',
    apply: (o) => { o.capabilities.push({ ...clone(o.capabilities[0]!), capabilityId: 'cap_extra', name: 'An Unlisted Extra Duty' }); },
    check: (b, m) => { assert.equal(metric(m, 'capabilityPrecision'), undefined, 'no precision metric exists in an open world'); assert.equal(canonicalJson(m.metrics), canonicalJson(b.metrics), 'no metric moves'); } });
  assert.equal(r.status, 'not_applicable');
});

test('M03 semantic fact recall: removing the node an expected fact identifies lowers semanticRecall', () => {
  const fact = SYN.def.expect.semantics!.facts![0]!;
  run({ id: 'M03', target: 'semantics / recall', description: `remove the node identified by fact "${fact.id}"`, fixture: SYN, metric: 'semanticRecall', expect: 'decrease', pipeline: true,
    apply: (o) => { const i = o.nodes.findIndex((n) => n.kind === fact.kind && evalAll(n.properties, fact.identify)); assert.ok(i >= 0, 'the expectation identity is observable'); o.nodes.splice(i, 1); } });
});

test('M04 semantic precision: an incorrect fact of a closed-world kind lowers precision, without matching any expected identity', () => {
  const facts = SYN.def.expect.semantics!.facts!;
  run({ id: 'M04', target: 'semantics / precision', description: 'inject a decision_node with unrelated content', fixture: SYN, metric: 'semanticPrecision', expect: 'decrease', pipeline: true,
    apply: (o) => { const proto = o.nodes.find((n) => n.kind === 'decision_node')!; const bad = { ...clone(proto), id: 'node_injected', properties: { ...proto.properties, question: 'the weather is sunny', outcome: 'carry an umbrella' } };
      assert.ok(!facts.some((f) => f.kind === bad.kind && evalAll(bad.properties, f.identify)), 'it matches no expected identity'); o.nodes.push(bad); } });
});

// ---- 5-7: execution -----------------------------------------------------------------------------------

test('M05 execution class: changing a deterministic capability to human_in_the_loop lowers executionClassAccuracy', () => {
  const { k, i } = firstExpectedFound(COM, (x) => x.executionClass === 'deterministic_rule');
  run({ id: 'M05', target: 'execution class', description: `set "${k.id}" deterministic_rule -> human_in_the_loop`, fixture: COM, metric: 'executionClassAccuracy', expect: 'decrease', pipeline: true,
    apply: (o) => { o.capabilities[i]!.executionClass = 'human_in_the_loop'; } });
});

test('M06 resolution: resolved -> unresolved lowers resolutionAccuracy; the inverse (unresolved -> resolved) earns NO credit and is also caught', () => {
  const a = firstExpectedFound(COM, (x) => x.resolution === 'resolved');
  run({ id: 'M06a', target: 'resolution', description: `set "${a.k.id}" resolved -> unresolved`, fixture: COM, metric: 'resolutionAccuracy', expect: 'decrease', pipeline: true, apply: (o) => { o.capabilities[a.i]!.resolution = 'unresolved'; } });
  const b = firstExpectedFound(STR, (x) => x.resolution === 'unresolved');
  run({ id: 'M06b', target: 'resolution', description: `set "${b.k.id}" unresolved -> resolved (golden says unresolved)`, fixture: STR, metric: 'resolutionAccuracy', expect: 'decrease', pipeline: true, apply: (o) => { o.capabilities[b.i]!.resolution = 'resolved'; } });
});

test('M07 execution correctness: success -> failure, and a wrong outcome, both lower executionCorrectness at the observation boundary', () => {
  run({ id: 'M07a', target: 'execution', description: 'A-manager-approval-required: succeeded -> invalid_input', fixture: COM, metric: 'executionCorrectness', expect: 'decrease', pipeline: true,
    apply: (o) => { const e = o.executions.find((x) => x.requestId === 'A-manager-approval-required')!; (e as any).outcome = 'invalid_input'; delete (e as any).output; } });
  run({ id: 'M07b', target: 'execution', description: 'B-manager-approval-not-required: wrong result (matched flipped)', fixture: COM, metric: 'executionCorrectness', expect: 'decrease', pipeline: true,
    apply: (o) => { const e = o.executions.find((x) => x.requestId === 'B-manager-approval-not-required')! as any; e.output = { ...(e.output ?? {}), matched: !(e.output?.matched ?? false) }; } });
});

// ---- 8-9: producer attribution ---------------------------------------------------------------------------

test('M08 wrong producer lowers CORRECTNESS but not COVERAGE (presence is not correctness)', () => {
  run({ id: 'M08', target: 'producer / correctness', description: 'structured-operation -> rule-based on an operation node', fixture: STR, metric: 'producerAttributionCorrectness', expect: 'decrease', pipeline: true,
    apply: (o) => { const n = o.nodes.find((x) => x.kind === 'capability' && x.producedBy === 'structured-operation')!; n.producedBy = 'rule-based'; },
    check: (b, m) => assert.equal(ratioOf(m, 'producerAttributionCoverage'), ratioOf(b, 'producerAttributionCoverage'), 'coverage must not move') });
});

test('M09 missing producer lowers COVERAGE and is not silently treated as correct', () => {
  run({ id: 'M09', target: 'producer / coverage', description: 'remove producedBy from a knowledge-path concept node', fixture: SYN, metric: 'producerAttributionCoverage', expect: 'decrease', pipeline: true,
    apply: (o) => { const n = o.nodes.find((x) => x.kind === 'concept' && x.producedBy !== undefined)!; delete n.producedBy; },
    check: (_b, m) => assert.equal(metric(m, 'producerAttributionCoverage')!.missing.length, 1) });
});

// ---- 10-11: provenance --------------------------------------------------------------------------------------

test('M10 broken provenance chain: removing the capability node from its contract links lowers provenanceChainCoverage', () => {
  run({ id: 'M10', target: 'provenance / chain', description: 'drop the capability node from sourceXoirNodeIds', fixture: SYN, metric: 'provenanceChainCoverage', expect: 'decrease', pipeline: true,
    apply: (o) => { const p = o.provenance!.capabilities[0]! as any; p.sourceXoirNodeIds = p.sourceXoirNodeIds.filter((id: string) => id !== p.capabilityId); },
    check: (_b, m) => assert.match(metric(m, 'provenanceChainCoverage')!.missing[0]!.reason, /nodes_resolve/) });
});

test('M11 execution provenance: a mutated contractContentHash / bindingId / contractId agreement is `mismatch`, and `unknown` on another field cannot mask it', () => {
  for (const field of ['contractContentHash', 'bindingId', 'contractId'] as const)
    run({ id: `M11-${field}`, target: 'provenance / execution agreement', description: `agreement.${field}: match -> mismatch`, fixture: SYN, metric: 'executionProvenanceAgreement', expect: 'decrease', pipeline: true,
      apply: (o) => { const e = o.executions.find((x: any) => x.kind === 'capability' && x.provenance)! as any; e.provenance.agreement[field] = 'mismatch'; },
      check: (_b, m) => assert.match(metric(m, 'executionProvenanceAgreement')!.mismatched[0]!.reason, new RegExp(field)) });
  run({ id: 'M11-masked', target: 'provenance / execution agreement', description: 'graphHash unknown + contractId mismatch: unknown must not mask the break', fixture: SYN, metric: 'executionProvenanceAgreement', expect: 'decrease', pipeline: true,
    apply: (o) => { const e = o.executions.find((x: any) => x.kind === 'capability' && x.provenance)! as any; e.provenance.agreement.graphHash = 'unknown'; e.provenance.agreement.contractId = 'mismatch'; } });
});

// ---- 12-14: cross-path ----------------------------------------------------------------------------------------

test('M12 cross-path capability identity: a serialized capability with a different identity is detected', () => {
  run({ id: 'M12', target: 'cross-path / capability', description: 'rename one capability id in the serialized view', fixture: SYN, metric: 'crossPathConsistency', expect: 'decrease', pipeline: true,
    apply: (o) => { (o.paths![1]!.capabilities as any)[0].capabilityId = 'cap_mutated_identity'; } });
});

test('M13 cross-path contract: a changed package-boundary contract hash is detected (and not the live view)', () => {
  run({ id: 'M13', target: 'cross-path / contract', description: 'change a package-boundary contract hash', fixture: SYN, metric: 'crossPathConsistency', expect: 'decrease', pipeline: true,
    apply: (o) => { const c = (o.paths![2]!.capabilities as any).find((x: any) => x.contractEmbedded); c.contractContentHash = 'sha256:tampered'; },
    check: (_b, m) => assert.ok(metric(m, 'crossPathConsistency')!.mismatched.some((i) => i.id.startsWith('live_vs_package|contract_hash|'))) });
});

test('M14 cross-path execution: a changed package execution outcome, and a changed recorded provenance, are both detected', () => {
  run({ id: 'M14a', target: 'cross-path / execution', description: 'package execution outcome succeeded -> error', fixture: SYN, metric: 'crossPathConsistency', expect: 'decrease', pipeline: true,
    apply: (o) => { (o.paths![2]!.executions as any)[0].outcome = 'error'; } });
  run({ id: 'M14b', target: 'cross-path / execution provenance', description: 'package recorded contractContentHash changed', fixture: SYN, metric: 'crossPathConsistency', expect: 'decrease', pipeline: true,
    apply: (o) => { (o.paths![2]!.executions as any)[0].recorded.contractContentHash = 'sha256:other'; } });
});

test('M14c a dimension that is not observable is reported as such, never as a pass: a hand-built case has no cross-path or chain metric to mutate', () => {
  const ev = evaluateCase(RUN.def, RUN.obs);
  for (const id of ['crossPathConsistency', 'provenanceChainCoverage', 'producerAttributionCoverage'] as MetricId[]) assert.equal(metric(ev, id), undefined, `${id} is absent (not_observable), not 100%`);
  MATRIX.push({ mutation: 'M14c', target: 'cross-path / chain / producer on hand-built XOIR', description: 'any mutation of path views or provenance chain of runtime-mechanics', expected: 'no metric exists', actual: 'metrics absent', status: 'not_observable', classification: 'not_observable', ok: true });
});

// ---- 15-16: workflows ------------------------------------------------------------------------------------------

test('M15 workflow recall: removing an expected workflow lowers workflowRecall', () => {
  run({ id: 'M15', target: 'workflows / recall', description: 'drop the only workflow', fixture: STR, metric: 'workflowRecall', expect: 'decrease', pipeline: true, apply: (o) => { o.workflows.splice(0, o.workflows.length); } });
});

test('M16 workflow execution: a workflow that no longer runs lowers executionCorrectness', () => {
  run({ id: 'M16', target: 'workflows / execution', description: 'wf-hitl-review: ran -> refused', fixture: COM, metric: 'executionCorrectness', expect: 'decrease', pipeline: true,
    apply: (o) => { const e = o.executions.find((x) => x.requestId === 'wf-hitl-review')! as any; e.outcome = 'refused'; e.steps = []; delete e.runStatus; } });
});

// ---- 17-25: baseline / comparator / golden / population (Step 7 protocol) ---------------------------------------------

const RUN_REPORT = buildReport('runtime-mechanics', [evaluateCase(RUN.def, RUN.obs)]);
function push(mutation: string, target: string, description: string, expected: string, actual: string, ok: boolean, classification: string, status: Status = ok ? 'detected' : 'not_detected'): void {
  MATRIX.push({ mutation, target, description, expected, actual, status, classification, ok });
  assert.ok(ok, `${mutation}: expected ${expected}, got ${actual}`);
}

test('M17 baseline metric corruption: a changed baseline value is never accepted as equivalent', () => {
  const corrupted = clone(RUN_REPORT) as any;
  const m = corrupted.cases[0].metrics.find((x: any) => x.id === 'capabilityRecall'); m.numerator -= 1; m.ratio = m.numerator / m.denominator; m.missing.push({ id: 'k-fake', reason: 'fake', attributedStage: 'capabilities' });
  const a = classifyDifferences(corrupted, RUN_REPORT);
  push('M17', 'baseline metric', 'capabilityRecall numerator -1 in the baseline (nothing else changed)', 'not identical; a metric-level difference', `${a.decision}: ${a.differences.map((d) => d.class).join(',')}`, a.decision !== 'identical' && a.decision !== 'compatible' && a.differences.some((d) => d.metricId === 'capabilityRecall'), a.decision);
  const worse = clone(RUN_REPORT) as any; const w = worse.cases[0].metrics.find((x: any) => x.id === 'capabilityRecall'); w.numerator -= 1; w.ratio = w.numerator / w.denominator; w.missing.push({ id: 'k-fake', reason: 'fake', attributedStage: 'capabilities' });
  const reg = classifyDifferences(RUN_REPORT, worse);
  assert.equal(reg.decision, 'regression'); assert.ok(reg.differences.some((d) => d.class === 'semantic_regression' && d.metricId === 'capabilityRecall'));
});

test('M18 metric removal: a metric lost from the candidate earns no improvement credit and is a lost measurement; a historical metric absent from the baseline is NOT an expected addition', () => {
  const lost = clone(RUN_REPORT) as any; for (const c of lost.cases) c.metrics = c.metrics.filter((m: any) => m.id !== 'resolutionAccuracy'); lost.aggregate.metrics = lost.aggregate.metrics.filter((m: any) => m.id !== 'resolutionAccuracy');
  const cmp = compareReports(RUN_REPORT, lost);
  assert.equal(cmp.improvements.length, 0); assert.ok(cmp.warnings.some((w) => w.kind === 'metric_removed'));
  const a = classifyDifferences(RUN_REPORT, lost);
  push('M18a', 'candidate metric', 'resolutionAccuracy removed from the candidate', 'lost measurement, no improvement credit', `${a.decision}; improvements ${cmp.improvements.length}`, a.decision === 'regression' && cmp.improvements.length === 0, a.decision);
  const b = classifyDifferences(lost, RUN_REPORT);
  push('M18b', 'baseline metric', 'resolutionAccuracy removed from the BASELINE (a historical metric)', 'explicit: not an expected addition', `${b.decision}: ${b.differences.map((d) => d.class).join(',')}`, b.decision === 'not_comparable', b.decision);
});

test('M19-M21 fingerprint, configuration and evaluation-version corruption are each classified, never identical', () => {
  const fp = clone(RUN_REPORT) as any; fp.cases[0].fingerprints.capabilities = 'deadbeefdeadbeef';
  const a = classifyDifferences(fp, RUN_REPORT);
  push('M19', 'baseline fingerprint', 'a baseline capabilities fingerprint changed with no declared metadata', 'not identical; review/not_comparable', `${a.decision}: ${a.differences.map((d) => d.id).join(',')}`, a.decision === 'review_required' || a.decision === 'not_comparable' || a.decision === 'regression', a.decision);
  assert.ok(a.differences.some((d) => d.id === 'output|runtime-mechanics|capabilities'));
  const cfg = clone(RUN_REPORT) as any; cfg.cases[0].attribution.configurationId = 'cfg-corrupted';
  const b = classifyDifferences(cfg, RUN_REPORT);
  push('M20', 'configuration id', 'configuration id changed; observations unchanged', 'configuration_change, not identical', `${b.decision}: ${b.differences.map((d) => d.class).join(',')}`, b.differences.some((d) => d.class === 'configuration_change') && b.decision !== 'identical', b.decision);
  assert.ok(compareReports(cfg, RUN_REPORT).warnings.some((w) => w.kind === 'configuration_changed'));
  const ver = clone(RUN_REPORT) as any; ver.evaluationVersion = 'p0.9c-corrupted';
  const c = classifyDifferences(ver, RUN_REPORT);
  push('M21', 'evaluation version', 'evaluation version changed', 'evaluation_version_change and no semantic regression claim', `${c.decision}: ${c.differences.map((d) => d.class).join(',')}`, c.differences.some((d) => d.class === 'evaluation_version_change') && c.counts.semantic_regression === 0, c.decision);
});

test('M22-M23 golden expectation changes: undeclared => not_comparable; declared => golden_expectation_change and the metric movement is attributed to it, not to the implementation', () => {
  const ctx = { currentExpectations: { 'runtime-mechanics': 'bbbbbbbbbbbbbbbb' }, baselineExpectations: { 'runtime-mechanics': 'aaaaaaaaaaaaaaaa' } };
  const worse = clone(RUN_REPORT) as any; const w = worse.cases[0].metrics.find((x: any) => x.id === 'capabilityRecall'); w.numerator -= 1; w.ratio = w.numerator / w.denominator; w.missing.push({ id: 'k-fake', reason: 'fake', attributedStage: 'capabilities' });
  const undeclared = classifyDifferences(RUN_REPORT, worse, ctx);
  push('M22', 'golden expectation', 'fingerprint changed, no declaration, and recall dropped', 'not_comparable (never an improvement or ordinary regression)', undeclared.decision, undeclared.decision === 'not_comparable', undeclared.decision);
  const declared = classifyDifferences(RUN_REPORT, worse, { ...ctx, declaredGoldenChanges: [{ caseId: 'runtime-mechanics', fromFingerprint: 'aaaaaaaaaaaaaaaa', toFingerprint: 'bbbbbbbbbbbbbbbb', reason: 'self-test', evidence: 'self-test', affectedMetrics: ['capabilityRecall'], acceptedAt: 'self-test' }] });
  push('M23', 'golden expectation', 'same change, declared', 'golden_expectation_change; no semantic_regression', `${declared.decision}: ${declared.differences.map((d) => d.class).join(',')}`, declared.counts.semantic_regression === 0 && declared.differences.some((d) => d.class === 'golden_expectation_change' && d.metricId === 'capabilityRecall'), declared.decision);
});

test('M24-M25 population: undeclared loss is a regression; a declaration explains ONLY the metric it names', () => {
  const shrink = (r: BenchmarkReport, id: string) => { const x = clone(r) as any; for (const m of [...x.cases[0].metrics, ...x.aggregate.metrics]) if (m.id === id) { m.numerator -= 1; m.denominator -= 1; m.ratio = m.denominator === 0 ? null : m.numerator / m.denominator; } return x as BenchmarkReport; };
  const lost = shrink(shrink(RUN_REPORT, 'observedSourceRefCoverage'), 'executionClassAccuracy');
  const a = classifyDifferences(RUN_REPORT, lost);
  push('M24', 'population', 'two metrics lose one item from an otherwise unchanged population, undeclared', 'semantic_regression', `${a.decision}`, a.decision === 'regression' && a.differences.filter((d) => d.class === 'semantic_regression').length >= 2, a.decision);
  const b = classifyDifferences(RUN_REPORT, lost, { knownDrift: [{ caseId: 'runtime-mechanics', metricId: 'observedSourceRefCoverage', reason: 'declared', evidence: 'self-test' }] });
  const explained = b.differences.find((d) => d.metricId === 'observedSourceRefCoverage')!, unrelated = b.differences.find((d) => d.metricId === 'executionClassAccuracy')!;
  push('M25', 'population', 'the same loss, declared for observedSourceRefCoverage only', 'only the named metric is explained (Step 7 classifies a declared drift as known_historical_drift)', `named=${explained.class}; unrelated=${unrelated.class}; decision=${b.decision}`, explained.class === 'known_historical_drift' && unrelated.class === 'semantic_regression' && b.decision === 'regression', b.decision);
});

// ---- 8L accounting states ------------------------------------------------------------------------------------------

import { cap as capH, caseDef as caseH, observation as obsH } from './helpers.js';
const acct = (found: number, extra = 0, resolution = true) => {
  const def = caseH({ capabilities: { closedWorld: true, items: [0, 1, 2, 3].map((i) => ({ id: `k${i}`, name: { equals: `Cap${i}` }, ...(resolution ? { resolution: 'resolved' as const } : {}) })) } });
  return evaluateCase(def, obsH({ capabilities: [...Array.from({ length: found }, (_, i) => capH(`c${i}`, `Cap${i}`)), ...Array.from({ length: extra }, (_, i) => capH(`x${i}`, `Extra${i}`))] }));
};

test('accounting states: correct->incorrect, correct->missing, incorrect->correct, unexpected->correct, not_observable, not_applicable, absent new metric, removed metric', () => {
  const full = acct(4);
  // correct -> incorrect (wrong resolution) lowers correctness, not recall
  const wrongRes = evaluateCase(caseH({ capabilities: { items: [{ id: 'k0', name: { equals: 'Cap0' }, resolution: 'unresolved' }] } }), obsH({ capabilities: [capH('c0', 'Cap0')] }));
  assert.equal(ratioOf(wrongRes, 'capabilityRecall'), '1/1'); assert.equal(ratioOf(wrongRes, 'resolutionAccuracy'), '0/1');
  // correct -> missing lowers recall AND precision stays on observed
  const missing = acct(3);
  assert.equal(ratioOf(full, 'capabilityRecall'), '4/4'); assert.equal(ratioOf(missing, 'capabilityRecall'), '3/4');
  // incorrect -> correct improves
  assert.equal(ratioOf(evaluateCase(caseH({ capabilities: { items: [{ id: 'k0', name: { equals: 'Cap0' }, resolution: 'resolved' }] } }), obsH({ capabilities: [capH('c0', 'Cap0')] })), 'resolutionAccuracy'), '1/1');
  // unexpected -> (removed) restores precision; an unexpected item is a false positive in a closed world only
  const withExtra = acct(4, 2);
  assert.equal(ratioOf(withExtra, 'capabilityPrecision'), '4/6'); assert.equal(ratioOf(full, 'capabilityPrecision'), '4/4');
  assert.equal(metric(withExtra, 'capabilityPrecision')!.unexpected.length, 2);
  // not_observable: a stage that was not requested is not a failure and not a success
  const none = evaluateCase(caseH({ compile: { outcome: 'succeeds' } }), obsH({ stages: { compile: { stage: 'compile', status: 'ok' }, capabilities: { stage: 'capabilities', status: 'ok' }, workflows: { stage: 'workflows', status: 'ok' }, execution: { stage: 'execution', status: 'not_requested' } } as never }));
  assert.equal(metric(none, 'executionCorrectness'), undefined);
  // not_applicable never enters a denominator
  assert.equal(metric(evaluateCase(caseH({}), obsH({})), 'capabilityRecall'), undefined);
  // absent new metric must not become zero; removed metric must not earn credit
  const base = buildReport('s', [full]);
  const withNew = clone(base) as any; withNew.cases[0].metrics.push({ id: 'crossPathConsistency', stage: 'capabilities', definition: 'd', numerator: 0, denominator: 3, ratio: 0, measured: true, missing: [], unexpected: [], mismatched: [{ id: 'a', reason: 'r', attributedStage: 'capabilities' }] });
  assert.equal(compareReports(base, withNew).classification, 'no_change', 'a new metric is not a regression');
  const cmp = compareReports(withNew, base);
  assert.equal(cmp.improvements.length, 0, 'a vanished metric earns no improvement');
  for (const [id, a, b, s] of [['ACC-correct-incorrect', '1/1', '0/1', 'resolutionAccuracy'], ['ACC-correct-missing', '4/4', '3/4', 'capabilityRecall'], ['ACC-unexpected', '4/4', '4/6', 'capabilityPrecision']] as const)
    MATRIX.push({ mutation: id, target: 'accounting', description: id, expected: `${s} ${a} -> ${b}`, actual: `${s} ${a} -> ${b}`, status: 'detected', classification: 'accounting', ok: true });
});

// ---- 8M micro-average ---------------------------------------------------------------------------------------------

test('M-micro: the aggregate is sum(numerators)/sum(denominators), not the mean of per-case percentages; corrupting only the small case moves it exactly that much', () => {
  const small = (found: number) => evaluateCase(caseH({ capabilities: { items: [0, 1].map((i) => ({ id: `s${i}`, name: { equals: `S${i}` } })) } }, undefined, 'small'), obsH({ capabilities: Array.from({ length: found }, (_, i) => capH(`s${i}`, `S${i}`)) }));
  const large = evaluateCase(caseH({ capabilities: { items: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `l${i}`, name: { equals: `L${i}` } })) } }, undefined, 'large'), obsH({ capabilities: Array.from({ length: 8 }, (_, i) => capH(`l${i}`, `L${i}`)) }));
  const agg = (s: CaseEvaluation) => buildReport('s', [s, large]).aggregate.metrics.find((m) => m.id === 'capabilityRecall')!;
  assert.deepEqual([agg(small(2)).numerator, agg(small(2)).denominator], [10, 10]);
  const corrupted = agg(small(0));
  assert.deepEqual([corrupted.numerator, corrupted.denominator], [8, 10], 'sum over sum');
  assert.notEqual(corrupted.ratio, (0 + 1) / 2, 'not the mean of the per-case ratios (0% and 100%)');
  assert.equal(corrupted.ratio, 0.8);
  MATRIX.push({ mutation: 'M-micro', target: 'aggregation', description: 'corrupt only the 2-item case of a 2-item + 8-item pair', expected: 'aggregate 8/10 (0.8), not 0.5', actual: `aggregate ${corrupted.numerator}/${corrupted.denominator}`, status: 'detected', classification: 'micro-average', ok: true });
});

// ---- 8N greedy matching / identity -----------------------------------------------------------------------------------

test('M-greedy: an actual candidate collision is REALIZED and recorded as an evaluation limitation (L3) — not fixed, not hidden', () => {
  // Two expectations whose matchers both match ONE observed capability: the greedy assignment credits both.
  const def = caseH({ capabilities: { closedWorld: true, items: [{ id: 'k1', name: { contains: 'Claim' } }, { id: 'k2', name: { equals: 'Claim Assessment' } }] } });
  const one = evaluateCase(def, obsH({ capabilities: [capH('c1', 'Claim Assessment')] }));
  assert.equal(ratioOf(one, 'capabilityRecall'), '2/2', 'LIMITATION L3: one observed capability satisfies two expectations (recall over-credited)');
  // And a collision that UNDER-credits precision: a perfect assignment (k1->c2, k2->c1) claims both, greedy leaves c2 unexpected.
  const two = evaluateCase(def, obsH({ capabilities: [capH('c1', 'Claim Assessment'), capH('c2', 'Claim Review')] }));
  assert.equal(ratioOf(two, 'capabilityRecall'), '2/2');
  assert.equal(ratioOf(two, 'capabilityPrecision'), '1/2', 'LIMITATION L3: c2 is reported unexpected although a perfect assignment would claim it');
  // Disjoint matchers (what every committed suite has — Step 3 audited this) behave exactly
  const clean = evaluateCase(caseH({ capabilities: { closedWorld: true, items: [{ id: 'k1', name: { equals: 'Claim Assessment' } }, { id: 'k2', name: { equals: 'Claim Review' } }] } }), obsH({ capabilities: [capH('c1', 'Claim Assessment'), capH('c2', 'Claim Review')] }));
  assert.equal(ratioOf(clean, 'capabilityPrecision'), '2/2');
  MATRIX.push({ mutation: 'M-greedy', target: 'identity matching', description: 'two expectations collide on one observed capability', expected: 'detected as ambiguous or not credited twice', actual: 'recall 2/2 from ONE capability (over-credit); precision 1/2 (under-credit)', status: 'not_detected', classification: 'evaluation limitation L3 (recorded, not fixed; the committed suites contain no colliding matchers)', ok: true });
});

// ---- 8O determinism & run-specific fields ----------------------------------------------------------------------------

test('determinism: repeated evaluation of the same observation gives identical metrics, items, warnings and report bytes', () => {
  const runs = [0, 1, 2].map(() => canonicalJson(buildReport('s', [evaluateCase(COM.def, COM.obs)])));
  assert.equal(new Set(runs).size, 1);
  const w = [0, 1, 2].map(() => canonicalJson(compareReports(buildReport('s', [evaluateCase(COM.def, COM.obs)]), buildReport('s', [evaluateCase(COM.def, COM.obs)])).warnings));
  assert.equal(new Set(w).size, 1);
});

test('run-specific fields: the report guard flags them; the manifest check rejects them; and the REAL observations carry none in their hashed fields (a documented gap: the report guard cannot see inside a fingerprint)', async () => {
  const { findRunSpecificFields, verifyManifestEntry, parseBaselineManifest, parseReport } = await import('../src/index.js');
  const { readFile } = await import('node:fs/promises');
  for (const key of ['timestamp', 'runId', 'hostname', 'createdAt', 'graphHash']) {
    const polluted = clone(buildReport('s', [evaluateCase(SYN.def, SYN.obs)])) as any; polluted.cases[0][key] = 'x';
    assert.deepEqual(findRunSpecificFields(polluted), [`$.cases[0].${key}`], key);
  }
  assert.deepEqual(findRunSpecificFields({ p: '/home/me/run' }), ['$.p (absolute path)']);
  const man = parseBaselineManifest(JSON.parse(await readFile(join(PKG, 'baselines', 'BASELINES.json'), 'utf8'))); assert.ok(man.ok);
  const e = man.value.entries.find((x) => x.suiteId === 'runtime-mechanics')!;
  const raw = await readFile(join(PKG, e.reportFile), 'utf8'); const rep: any = clone((parseReport(JSON.parse(raw)) as any).value); rep.cases[0].runId = 'r-1';
  assert.ok(verifyManifestEntry(e, rep, raw).some((f) => f.code === 'run_specific_field'));
  // hashed observation fields of every real observation are free of run-specific keys (graphHash lives only in the descriptive path / provenance views)
  for (const f of [SYN, STR, COM, RUN]) assert.deepEqual(findRunSpecificFields({ nodes: f.obs.nodes, capabilities: f.obs.capabilities, workflows: f.obs.workflows }), [], f.def.caseId);
  // injecting one into a hashed field is NOT stopped by the report guard: it changes the compile fingerprint. That is a real limitation, recorded.
  const injected = clone(SYN.obs) as any; injected.nodes[0].properties.createdAt = '2026-01-01T00:00:00Z';
  assert.ok(findRunSpecificFields(injected.nodes).length === 1, 'the observation-level guard sees it');
  MATRIX.push({ mutation: 'M-runspecific', target: 'report determinism', description: 'inject timestamp / runId / host / absolute path / graphHash into a report', expected: 'rejected by the guard', actual: 'flagged by findRunSpecificFields and verifyManifestEntry', status: 'detected', classification: 'guard', ok: true });
  MATRIX.push({ mutation: 'M-runspecific-hashed', target: 'report determinism', description: 'a run-specific value inside a HASHED observation property', expected: 'rejected before it reaches a fingerprint', actual: 'only findRunSpecificFields(observation) sees it; nothing in the pipeline calls it', status: 'not_detected', classification: 'evaluation limitation (recorded)', ok: true });
});

// ---- 8P false-pass attempts -------------------------------------------------------------------------------------------

test('FALSE-PASS: each deliberate attempt to make something wrong and still get a passing evaluation FAILS to pass', () => {
  const attempts: [string, Spec][] = [
    ['remove expected capability', { id: 'FP1', target: 'capabilities', description: '', fixture: SYN, metric: 'capabilityRecall', expect: 'decrease', pipeline: true, apply: (o) => { o.capabilities.splice(capByName(o, 'Deny The Claim'), 1); } }],
    ['inject spurious capability', { id: 'FP2', target: 'capabilities', description: '', fixture: SYN, metric: 'capabilityPrecision', expect: 'decrease', pipeline: true, apply: (o) => { o.capabilities.push({ ...clone(o.capabilities[0]!), capabilityId: 'cap_fp', name: 'Spurious' }); } }],
    ['break provenance', { id: 'FP3', target: 'provenance', description: '', fixture: COM, metric: 'provenanceChainCoverage', expect: 'decrease', pipeline: true, apply: (o) => { (o.provenance!.capabilities[0]! as any).sourceRefs = []; } }],
    ['alter execution provenance', { id: 'FP4', target: 'execution provenance', description: '', fixture: COM, metric: 'executionProvenanceAgreement', expect: 'decrease', pipeline: true, apply: (o) => { const e = o.executions.find((x: any) => x.kind === 'capability' && x.provenance)! as any; e.provenance.agreement.bindingId = 'mismatch'; } }],
    ['corrupt a cross-path result', { id: 'FP5', target: 'cross-path', description: '', fixture: COM, metric: 'crossPathConsistency', expect: 'decrease', pipeline: true, apply: (o) => { (o.paths![1]!.capabilities as any)[3].contractContentHash = 'sha256:x'; } }],
    ['wrong producer', { id: 'FP6', target: 'producer', description: '', fixture: STR, metric: 'producerAttributionCorrectness', expect: 'decrease', pipeline: true, apply: (o) => { o.nodes.filter((x) => x.producedBy === 'structured-operation').forEach((n) => { n.producedBy = 'ai'; }); } }],
    ['wrong execution class', { id: 'FP7', target: 'execution class', description: '', fixture: COM, metric: 'executionClassAccuracy', expect: 'decrease', pipeline: true, apply: (o) => { const k = firstExpectedFound(COM, (x) => x.executionClass === 'deterministic_rule'); o.capabilities[k.i]!.executionClass = 'not_executable'; } }],
  ];
  let unexpectedPass = 0;
  for (const [what, spec] of attempts) {
    const row = run({ ...spec, description: what });
    if (!row.ok) unexpectedPass++;
  }
  assert.equal(unexpectedPass, 0, 'an unexpected pass is a blocker');
});

// ---- matrix -------------------------------------------------------------------------------------------------------------

test('the mutation matrix: every row is accounted for; detected / not_detected / not_observable / not_applicable are kept apart', () => {
  const by = (s: Status) => MATRIX.filter((r) => r.status === s).length;
  const judged = by('detected') + by('not_detected');
  const rate = judged === 0 ? null : by('detected') / judged;
  assert.ok(MATRIX.length >= 40, `matrix rows: ${MATRIX.length}`);
  // the only not_detected rows are the two recorded evaluation limitations
  assert.deepEqual(MATRIX.filter((r) => r.status === 'not_detected').map((r) => r.mutation).sort(), ['M-greedy', 'M-runspecific-hashed']);
  assert.ok(MATRIX.every((r) => r.ok));
  console.log(`MUTATION MATRIX: ${MATRIX.length} rows | detected ${by('detected')} | not_detected ${by('not_detected')} | not_observable ${by('not_observable')} | not_applicable ${by('not_applicable')} | detection rate ${rate === null ? 'n/a' : (rate * 100).toFixed(1) + '%'} of judged (not-observable / not-applicable excluded)`);
});

after(() => { if (process.env['XO_SELF_TEST_MATRIX']) writeFileSync(process.env['XO_SELF_TEST_MATRIX'], JSON.stringify(MATRIX, null, 2)); });

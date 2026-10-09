import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORICAL_METRIC_IDS,
  METRIC_MODEL,
  PROVENANCE_METRIC_IDS,
  buildReport,
  canonicalJson,
  compareReports,
  evaluateCase,
  fingerprintOf,
  loadSuiteFile,
  observeCase,
  type ObservedAgreement,
  type ObservedCapabilityExecution,
  type ObservedCapabilityProvenance,
  type ObservedExecutionProvenance,
  type PipelineObservation,
} from '../src/index.js';
import { cap, caseDef, metricOf, node, observation, okStages } from './helpers.js';

/**
 * P0.9C Step 5 — evidence / provenance. Producer attribution (Step 4) is a separate dimension and is never read here. Both metrics are
 * descriptive: judged against independent structure, not against a golden expectation.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const ratio = (m: { numerator: number; denominator: number } | undefined): string => (m === undefined ? 'absent' : `${m.numerator}/${m.denominator}`);

// ---- builders ---------------------------------------------------------------------------------

const SRC = 'examples/a.pdf';
const refNode = (id: string, kind = 'concept', pages: number[] = [1]) => node(id, kind, {}, { pages, doc: SRC });
const prov = (over: Partial<ObservedCapabilityProvenance> = {}): ObservedCapabilityProvenance => ({
  capabilityId: 'cap1', name: 'Alpha', contractId: 'ctr1', contractContentHash: 'h1', contractContentHashRecomputed: 'h1', graphHash: 'g1',
  binding: { status: 'resolved', bindingId: 'b1' }, sourceXoirNodeIds: ['cap1', 'rule1'], sourceRefs: [{ documentPath: SRC, pages: [1] }], ...over,
});
function withProvenance(caps: ObservedCapabilityProvenance[], parts: Parameters<typeof observation>[0] = {}): PipelineObservation {
  const nodes = parts.nodes ?? [refNode('cap1', 'capability'), refNode('rule1', 'heuristic')];
  return { ...observation({ ...parts, nodes }), sourceReports: [{ sourceType: 'pdf', path: SRC }], provenance: { capabilities: caps } };
}
const chain = (o: PipelineObservation) => metricOf(evaluateCase(caseDef({}), o), 'provenanceChainCoverage');

const agree = (over: Partial<Record<'graphHash' | 'contractContentHash' | 'bindingId' | 'contractId', ObservedAgreement>> = {}): ObservedExecutionProvenance => ({
  recorded: { contractId: 'ctr1', bindingId: 'b1', graphHash: 'g1', contractContentHash: 'h1' }, graphViewAvailable: true,
  agreement: { graphHash: 'match', contractContentHash: 'match', bindingId: 'match', contractId: 'match', ...over },
});
const run = (id: string, provenance?: ObservedExecutionProvenance, outcome: ObservedCapabilityExecution['outcome'] = 'succeeded'): ObservedCapabilityExecution => ({ requestId: id, kind: 'capability', outcome, ...(provenance ? { provenance } : {}) });
const agreement = (execs: ObservedCapabilityExecution[]) => metricOf(evaluateCase(caseDef({}), observation({ executions: execs })), 'executionProvenanceAgreement');

// ---- 1. existing provenance metrics: preserved, and distinct from the chain ---------------------

test('the existing source-reference metrics keep their definitions; the Step 5 metrics are separate, registered, descriptive and add nothing to the historical set', () => {
  assert.deepEqual([...PROVENANCE_METRIC_IDS], ['executionProvenanceAgreement', 'provenanceChainCoverage']);
  for (const id of PROVENANCE_METRIC_IDS) { assert.equal(METRIC_MODEL[id].role, 'descriptive'); assert.equal(METRIC_MODEL[id].countsTowardSuiteMeasured, false); assert.ok(!HISTORICAL_METRIC_IDS.includes(id)); }
  assert.equal(METRIC_MODEL.provenanceCompleteness.role, 'graded');
  assert.equal(METRIC_MODEL.observedSourceRefCoverage.role, 'descriptive');
  assert.equal(HISTORICAL_METRIC_IDS.length, 20);
});

test('source-reference metrics cannot see a broken chain; chain coverage can (the audit finding): provenanceCompleteness and observedSourceRefCoverage are IDENTICAL for a connected and a broken chain', () => {
  const def = caseDef({ capabilities: { items: [{ id: 'k', name: { equals: 'Alpha' }, evidence: { minSourceRefs: 1 } }] } });
  const capObs = [{ ...cap('cap1', 'Alpha'), sourceRefs: [{ documentPath: SRC, pages: [1] }] }];
  const good = { ...withProvenance([prov()], { capabilities: capObs }) };
  const broken = { ...withProvenance([prov({ sourceXoirNodeIds: ['cap1', 'ghost-node'] })], { capabilities: capObs }) };
  const hist = (o: PipelineObservation) => canonicalJson(evaluateCase(def, o).metrics.filter((m) => HISTORICAL_METRIC_IDS.includes(m.id)));
  assert.equal(hist(good), hist(broken), 'no historical metric moves');
  assert.equal(ratio(metricOf(evaluateCase(def, good), 'provenanceCompleteness')), '1/1');
  assert.equal(ratio(metricOf(evaluateCase(def, good), 'provenanceChainCoverage')), '1/1');
  assert.equal(ratio(metricOf(evaluateCase(def, broken), 'provenanceChainCoverage')), '0/1');
});

// ---- 2. chain coverage ------------------------------------------------------------------------

test('chain: a complete chain passes; every link is checked against independent structure and a broken one is a missing item naming the link', () => {
  assert.equal(ratio(chain(withProvenance([prov()]))), '1/1');
  const cases: [string, Partial<ObservedCapabilityProvenance>, string][] = [
    ['missing source link: contract ref points at a document that is not a declared source', { sourceRefs: [{ documentPath: 'other.pdf', pages: [1] }] }, 'source_resolves'],
    ['missing source link: the contract carries no source refs at all', { sourceRefs: [] }, 'source_resolves'],
    ['missing capability link: a linked node id is not in the graph', { sourceXoirNodeIds: ['cap1', 'ghost'] }, 'nodes_resolve'],
    ['missing capability link: the contract does not link its own capability node', { sourceXoirNodeIds: ['rule1'] }, 'nodes_resolve'],
    ['refs not carried: the contract cites a page no linked node cites', { sourceRefs: [{ documentPath: SRC, pages: [9] }] }, 'refs_carried'],
    ['missing contract: the content hash is absent', { contractContentHash: '', contractContentHashRecomputed: '' }, 'hash_deterministic'],
    ['non-deterministic contract hash: a second projection differs', { contractContentHashRecomputed: 'other' }, 'hash_deterministic'],
  ];
  for (const [label, over, link] of cases) {
    const m = chain(withProvenance([prov(over)]))!;
    assert.equal(ratio(m), '0/1', label);
    assert.match(m.missing[0]!.reason, new RegExp(link), label);
    assert.equal(m.missing[0]!.attributedStage, 'capabilities');
  }
});

test('chain: binding state is observed, never required — an unresolved / ambiguous / denied binding is a legitimate outcome, not a broken link', () => {
  for (const status of ['unresolved', 'ambiguous', 'denied'] as const) {
    const m = chain(withProvenance([prov({ binding: { status } })]))!;
    assert.equal(ratio(m), '1/1', status);
    assert.equal(m.breakdown![`binding.${status}`], 1);
  }
});

test('chain: not observable / not applicable states stay distinct from failure — no compile, no provenance, or no capability emits NO metric (never 0%)', () => {
  const skipped = withProvenance([prov()], { stages: okStages({ compile: { stage: 'compile', status: 'skipped', note: 'serialized XOIR entry' } }) });
  assert.equal(chain(skipped), undefined);
  const { provenance: _drop, ...noProvenance } = withProvenance([prov()]);
  assert.equal(chain(noProvenance as PipelineObservation), undefined);
  assert.equal(chain(withProvenance([])), undefined);
});

test('chain: descriptive for `measured`, micro-averaged, deterministic and pure', () => {
  const c = (id: string, over: Partial<ObservedCapabilityProvenance> = {}) => prov({ capabilityId: id, name: id, sourceXoirNodeIds: [id], ...over });
  const nodes = [refNode('a', 'capability'), refNode('b', 'capability'), refNode('c', 'capability')];
  const one = evaluateCase(caseDef({}, undefined, 'one'), withProvenance([c('a'), c('b', { sourceRefs: [] })], { nodes })); // 1/2
  const two = evaluateCase(caseDef({}, undefined, 'two'), withProvenance([c('c')], { nodes })); // 1/1
  const report = buildReport('s', [one, two]);
  assert.equal(ratio(report.aggregate.metrics.find((m) => m.id === 'provenanceChainCoverage')), '2/3');
  assert.equal(report.measured, false, 'descriptive: an expectation-free suite is not "measured"');
  assert.equal(report.aggregate.metrics.find((m) => m.id === 'provenanceChainCoverage')!.missing[0]!.caseId, 'one');
  // pure and deterministic
  const freeze = <T,>(v: T): T => { if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) freeze(x); } return v; };
  const o = withProvenance([c('a'), c('b')], { nodes });
  assert.equal(canonicalJson(evaluateCase(caseDef({}), o)), canonicalJson(evaluateCase(caseDef({}), freeze(withProvenance([c('a'), c('b')], { nodes })))));
  // order independence: metrics and items (the helper fingerprints nodes in the order given; the real observer sorts them)
  const pick = (e: ReturnType<typeof evaluateCase>) => canonicalJson({ metrics: e.metrics, items: e.items });
  assert.equal(pick(evaluateCase(caseDef({}), o)), pick(evaluateCase(caseDef({}), withProvenance([c('b'), c('a')], { nodes: [...nodes].reverse() }))));
});

// ---- 3. execution provenance agreement ---------------------------------------------------------

test('agreement: match, and a mismatch on EACH field is detected and named (graph hash, contract hash, binding, contract id)', () => {
  assert.equal(ratio(agreement([run('r', agree())])), '1/1');
  for (const field of ['graphHash', 'contractContentHash', 'bindingId', 'contractId'] as const) {
    const m = agreement([run('r', agree({ [field]: 'mismatch' }))])!;
    assert.equal(ratio(m), '0/1', field);
    assert.deepEqual(m.mismatched.map((i) => i.id), ['execution|r']);
    assert.match(m.mismatched[0]!.reason, new RegExp(field));
    assert.equal(m.mismatched[0]!.attributedStage, 'execution');
  }
  const both = agreement([run('r', agree({ graphHash: 'mismatch', bindingId: 'mismatch' }))])!;
  assert.match(both.mismatched[0]!.reason, /bindingId, graphHash/, 'every mismatching field is named, sorted');
});

test('agreement: `unknown` (one side absent), `not_exercised` and `not_observable` are reported separately and are never failures or successes', () => {
  const m = agreement([
    run('match', agree()),
    run('unknown-graph', agree({ graphHash: 'unknown' })), // installed-package style: no graphHash recorded
    run('unknown-view', { ...agree({ graphHash: 'unknown', contractContentHash: 'unknown', bindingId: 'unknown', contractId: 'unknown' }), graphViewAvailable: false }),
    run('not-run', undefined, 'not_executable'),
    run('invalid', undefined, 'invalid_input'),
    run('ran-without-record', undefined, 'succeeded'),
  ])!;
  assert.equal(ratio(m), '1/1', 'only determinable units are in the denominator');
  assert.deepEqual(m.breakdown, { 'state.match': 1, 'state.not_exercised': 2, 'state.not_observable': 1, 'state.unknown': 2 });
  assert.equal(m.mismatched.length, 0);
  // a mismatch beats unknown; unknown beats nothing
  assert.equal(ratio(agreement([run('x', agree({ graphHash: 'unknown', bindingId: 'mismatch' }))])), '0/1');
  // nothing determinable => absent, never 0%
  assert.equal(agreement([run('a', agree({ graphHash: 'unknown' })), run('b', undefined, 'not_executable')]), undefined);
  assert.equal(agreement([]), undefined);
});

test('agreement: workflow steps are units; refused / not-run workflows and un-run steps are not_exercised; deterministic and micro-averaged', () => {
  const step = (name: string, provenance?: ObservedExecutionProvenance, engineStepStatus = 'completed') => ({ capabilityId: name, name, engineStepStatus, ...(provenance ? { provenance } : {}) });
  const wf = (id: string, steps: ReturnType<typeof step>[], outcome: 'ran' | 'refused' = 'ran') => ({ requestId: id, kind: 'workflow' as const, outcome, steps });
  const m = metricOf(evaluateCase(caseDef({}), observation({ executions: [wf('w1', [step('a', agree()), step('b', agree({ contractId: 'mismatch' })), step('c', undefined, 'not_reached')]), wf('w2', [], 'refused')] })), 'executionProvenanceAgreement')!;
  assert.equal(ratio(m), '1/2');
  assert.deepEqual(m.mismatched.map((i) => i.id), ['execution|w1#2']);
  assert.equal(m.breakdown!['state.not_exercised'], 2);
  const a = evaluateCase(caseDef({}, undefined, 'a'), observation({ executions: [run('r1', agree())] }));
  const b = evaluateCase(caseDef({}, undefined, 'b'), observation({ executions: [run('r1', agree()), run('r2', agree({ graphHash: 'mismatch' }))] }));
  assert.equal(ratio(buildReport('s', [a, b]).aggregate.metrics.find((x) => x.id === 'executionProvenanceAgreement')), '2/3');
  assert.equal(canonicalJson(buildReport('s', [a, b])), canonicalJson(buildReport('s', [a, b])));
  assert.equal(buildReport('s', [a]).measured, false, 'descriptive');
});

test('agreement is regression-safe: a mismatch changes no historical metric and no classification of an unrelated comparison', () => {
  const good = evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({ executions: [run('r', agree())] }));
  const bad = evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({ executions: [run('r', agree({ graphHash: 'mismatch' }))] }));
  const hist = (e: typeof good) => canonicalJson(e.metrics.filter((m) => HISTORICAL_METRIC_IDS.includes(m.id)));
  assert.equal(hist(good), hist(bad));
  assert.equal(compareReports(buildReport('s', [good]), buildReport('s', [good])).classification, 'no_change');
});

// ---- 4. the real pipeline, all 8 cases ----------------------------------------------------------

test('real pipeline (all 8 cases): every compiled capability has a connected chain; every executed capability agrees with the live-graph view; hand-built XOIR has no chain metric; the projection is consumed unchanged', async () => {
  let compiledCaps = 0, executed = 0;
  for (const name of ['vertical-fixtures', 'runtime-mechanics']) {
    const l = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
    assert.ok(l.ok);
    for (const def of l.suite.cases) {
      const obs = await observeCase(def, { sourceRoot: l.sourceRoot });
      const ev = evaluateCase(def, obs);
      const compiled = obs.stages.compile.status === 'ok';
      const c = metricOf(ev, 'provenanceChainCoverage');
      if (!compiled) assert.equal(c, undefined, `${def.caseId}: hand-built XOIR => chain not observable (no compile result to resolve sources against)`);
      else {
        assert.equal(c!.numerator, c!.denominator, `${def.caseId}: ${JSON.stringify(c!.missing)}`);
        assert.equal(c!.denominator, obs.provenance!.capabilities.length);
        compiledCaps += c!.denominator;
      }
      const a = metricOf(ev, 'executionProvenanceAgreement');
      if (a !== undefined) { assert.equal(a.numerator, a.denominator, `${def.caseId}: ${JSON.stringify(a.mismatched)}`); executed += a.denominator; }
      // every observed capability has a projection whose ids exist in the graph
      for (const p of obs.provenance!.capabilities) {
        assert.ok(obs.capabilities.some((x) => x.capabilityId === p.capabilityId), `${def.caseId}: ${p.capabilityId}`);
        assert.equal(p.contractContentHash, p.contractContentHashRecomputed, 'the contract hash is deterministic');
      }
    }
  }
  assert.equal(compiledCaps, 71, 'capabilities across the 7 compiled cases');
  assert.ok(executed >= 20, `executions judged: ${executed}`);
});

test('ExperienceUnit limitation is recorded, not worked around: the observed ref carries no unit id, and no benchmark-only mapping exists', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const obs = await observeCase(l.suite.cases.find((c) => c.caseId === 'synthetic-claim-rules')!, { sourceRoot: l.sourceRoot });
  for (const n of obs.nodes) for (const r of n.sourceRefs) assert.deepEqual(Object.keys(r).filter((k) => !['documentPath', 'locator', 'pages'].includes(k)), [], 'ObservedSourceRef exposes documentPath / locator / pages only');
  for (const p of obs.provenance!.capabilities) for (const r of p.sourceRefs) assert.deepEqual(Object.keys(r).filter((k) => !['documentPath', 'locator', 'pages'].includes(k)), []);
  assert.ok(METRIC_MODEL.provenanceChainCoverage.limitations.includes('L14'));
});

test('provenance is observation data only: it is excluded from every stage fingerprint (like producedBy and subtype), so no fingerprint moved', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'runtime-mechanics.suite.json'));
  assert.ok(l.ok);
  const obs = await observeCase(l.suite.cases[0]!, { sourceRoot: l.sourceRoot });
  assert.ok(obs.executions.some((e) => (e.kind === 'capability' ? e.provenance !== undefined : e.steps.some((s) => s.provenance !== undefined))), 'the runtime facts are observed');
  const stripped = obs.executions.map((e) => (e.kind === 'capability' ? (({ provenance: _p, ...r }) => r)(e) : { ...e, steps: e.steps.map(({ provenance: _p, ...r }) => r) }));
  assert.equal(obs.fingerprints.execution, fingerprintOf(stripped));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CROSS_PATH_METRIC_IDS,
  CROSS_PATH_STATES,
  HISTORICAL_METRIC_IDS,
  INSTALLED_PATH_BINDING_CLASS,
  LOWERABLE_IMPLEMENTATION_CLASSES,
  METRIC_MODEL,
  PATH_INVENTORY,
  buildReport,
  canonicalJson,
  compareViews,
  evaluateCase,
  loadSuiteFile,
  observeCase,
  type CrossPathUnit,
  type PathCapabilityView,
  type PathView,
} from '../src/index.js';
import { lowerCapabilitiesToManifest } from '@xo/compiler';
import { caseDef, metricOf, observation, okStages } from './helpers.js';

/** P0.9C Step 6 — cross-path. The tests MEASURE disagreement; none reconciles a path. Only match / mismatch are ever judged. */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const ratio = (m: { numerator: number; denominator: number } | undefined): string => (m === undefined ? 'absent' : `${m.numerator}/${m.denominator}`);

// ---- builders ---------------------------------------------------------------------------------

const det = { status: 'resolved' as const, bindingId: 'b-det', implementationClass: 'deterministic_rule' };
const hitl = { status: 'resolved' as const, bindingId: 'b-hitl', implementationClass: 'human_in_the_loop' };
const capV = (id: string, over: Partial<PathCapabilityView> = {}): PathCapabilityView => ({ capabilityId: id, name: id, contractContentHash: `h-${id}`, binding: det, ...over });
const view = (path: PathView['path'], caps: PathCapabilityView[], over: Partial<PathView> = {}): PathView => ({ path, graphIdentity: path === 'package_boundary' ? 'lowered' : 'unlowered', ...(path === 'package_boundary' ? {} : { graphHash: 'g1' }), capabilities: caps, executions: [], ...over });
const states = (u: readonly CrossPathUnit[]) => u.map((x) => `${x.dimension}:${x.subject}:${x.state}`);
const pkgCap = (id: string, over: Partial<PathCapabilityView> = {}): PathCapabilityView => ({ capabilityId: id, name: id, contractEmbedded: true, contractHash: undefined, contractContentHash: `h-${id}`, binding: det, ...over } as PathCapabilityView);

// ---- 1. inventory ---------------------------------------------------------------------------------

test('path inventory: every cell is one of the four allowed states; only paths the benchmark actually builds are `observed`; API / CLI / installed rows are never observed here and say how they are covered elsewhere', () => {
  const allowed = new Set(['observed', 'not_exercised', 'not_observable', 'not_applicable']);
  assert.ok(PATH_INVENTORY.length >= 10);
  for (const row of PATH_INVENTORY) {
    for (const k of ['input', 'compile', 'capabilityDiscovery', 'contract', 'binding', 'execution', 'provenance'] as const) assert.ok(allowed.has(row[k]), `${row.path}.${k}`);
    assert.ok(row.externalCoverage.length > 0);
  }
  for (const row of PATH_INVENTORY.filter((r) => /^(API|CLI|installed)/.test(r.path))) for (const k of ['compile', 'execution'] as const) assert.notEqual(row[k], 'observed', `${row.path}.${k}: the benchmark does not exercise it`);
  assert.ok(PATH_INVENTORY.some((r) => r.input === 'observed' && /package boundary/.test(r.path)));
  assert.ok(PATH_INVENTORY.find((r) => /installed package/.test(r.path))!.execution === 'not_exercised', 'the installed package is never pretended');
  assert.ok(PATH_INVENTORY.find((r) => /package boundary/.test(r.path))!.externalCoverage.includes('NOT exercised'));
});

// ---- 2. comparator: states ---------------------------------------------------------------------

test('serialized pair: identical semantic output matches on every dimension (graph hash, capability set, contract hash, binding)', () => {
  const live = view('live_graph', [capV('a'), capV('b', { binding: hitl })]);
  const ser = view('serialized_graph', [capV('b', { binding: hitl }), capV('a')]); // order differs: identity is by capability id, never by position
  const u = compareViews('live_vs_serialized', live, ser);
  assert.deepEqual(u.filter((x) => x.state !== 'match'), []);
  assert.deepEqual(states(u), ['graph_hash:*graph*:match', 'capability_present:a:match', 'contract_hash:a:match', 'binding:a:match', 'capability_present:b:match', 'contract_hash:b:match', 'binding:b:match']);
});

test('serialized pair: each kind of disagreement is a mismatch naming its dimension — graph hash, missing/extra capability, contract hash, binding', () => {
  const live = view('live_graph', [capV('a'), capV('b')]);
  const one = (ser: PathView) => compareViews('live_vs_serialized', live, ser).filter((x) => x.state === 'mismatch').map((x) => `${x.dimension}:${x.subject}`);
  assert.deepEqual(one(view('serialized_graph', [capV('a'), capV('b')], { graphHash: 'g2' })), ['graph_hash:*graph*']);
  assert.deepEqual(one(view('serialized_graph', [capV('a')])), ['capability_present:b']);
  assert.deepEqual(one(view('serialized_graph', [capV('a'), capV('b'), capV('c')])), ['capability_present:c']);
  assert.deepEqual(one(view('serialized_graph', [capV('a'), capV('b', { contractContentHash: 'tampered' })])), ['contract_hash:b']);
  assert.deepEqual(one(view('serialized_graph', [capV('a'), capV('b', { binding: { ...det, bindingId: 'other' } })])), ['binding:b']);
  assert.deepEqual(one(view('serialized_graph', [capV('a', { binding: { status: 'unresolved' } }), capV('b')])), ['binding:a']);
});

test('`unknown` is a side that did not record a value; it is never a mismatch and never a match', () => {
  const live = view('live_graph', [capV('a')]);
  const noHash = compareViews('live_vs_serialized', live, view('serialized_graph', [capV('a', { contractContentHash: undefined })], { graphHash: undefined as never }));
  assert.deepEqual(noHash.filter((x) => x.state === 'unknown').map((x) => `${x.dimension}:${x.subject}`), ['graph_hash:*graph*', 'contract_hash:a']);
  assert.equal(noHash.some((x) => x.state === 'mismatch'), false);
  const noBinding = compareViews('live_vs_serialized', live, view('serialized_graph', [capV('a', { binding: undefined })]));
  assert.equal(noBinding.find((x) => x.dimension === 'binding')!.state, 'unknown');
});

test('package pair: a graph hash is NOT compared across a lowered and an unlowered graph (different semantic objects) — missing graphHash on the package is not a failure', () => {
  const live = view('live_graph', [capV('a')]);
  const pkg = view('package_boundary', [pkgCap('a')]);
  const g = compareViews('live_vs_package', live, pkg).find((x) => x.dimension === 'graph_hash')!;
  assert.equal(g.state, 'not_comparable');
  assert.match(g.reason!, /lowering moves the content hash/);
  // even if the package DID carry a hash, it still would not be compared with the unlowered graph's
  const withHash = compareViews('live_vs_package', live, view('package_boundary', [pkgCap('a')], { graphHash: 'g9' })).find((x) => x.dimension === 'graph_hash')!;
  assert.equal(withHash.state, 'not_comparable');
});

test('package pair: scope is explicit — non-lowerable capabilities, and HITL bindings on the installed path, are `not_comparable` WITH the raw values kept; a lowerable capability with no embedded contract is a real mismatch', () => {
  const live = view('live_graph', [capV('det'), capV('hitl', { binding: hitl }), capV('unres', { binding: { status: 'unresolved' } }), capV('lost')]);
  const pkg = view('package_boundary', [pkgCap('det'), pkgCap('hitl', { binding: { status: 'unresolved' } }), { capabilityId: 'lost', name: 'lost', contractEmbedded: false }]);
  const u = compareViews('live_vs_package', live, pkg);
  const by = (d: string, s: string) => u.find((x) => x.dimension === d && x.subject === s)!;
  assert.equal(by('contract_embedded', 'det').state, 'match');
  assert.equal(by('contract_hash', 'det').state, 'match');
  assert.equal(by('binding', 'det').state, 'match');
  assert.equal(by('contract_embedded', 'unres').state, 'not_comparable', 'lowering embeds nothing for an unresolved capability');
  assert.equal(by('contract_embedded', 'lost').state, 'mismatch', 'lowerable but not embedded: a genuine package-boundary disagreement');
  const h = by('binding', 'hitl');
  assert.equal(h.state, 'not_comparable');
  assert.equal(h.left, 'resolved|b-hitl|human_in_the_loop');
  assert.equal(h.right, 'unresolved||', 'the by-design difference stays visible on the unit');
  assert.equal(by('contract_hash', 'hitl').state, 'match', 'HITL contracts ARE embedded, so their contract is compared');
});

test('package pair, execution: matching result is a match; a different outcome or result is a mismatch; HITL is out of the installed path\'s scope; a request that did not run is not_exercised; contract / binding provenance is compared, graphHash is not', () => {
  const rec = { contractId: 'c1', bindingId: 'b-det', contractContentHash: 'h-det' };
  const liveRun = (id: string, over = {}) => ({ requestId: id, capabilityId: 'det', outcome: 'succeeded', matched: true, recorded: { ...rec, graphHash: 'g1' }, ...over });
  const pkgRun = (id: string, over = {}) => ({ requestId: id, capabilityId: 'det', outcome: 'succeeded', matched: true, recorded: rec, ...over });
  const live = view('live_graph', [capV('det'), capV('hitl', { binding: hitl })], { executions: [liveRun('ok'), liveRun('bad-result'), liveRun('bad-prov'), liveRun('no-pkg'), { requestId: 'h', capabilityId: 'hitl', outcome: 'waiting_for_human' }, { requestId: 'nr', capabilityId: 'det', outcome: 'not_executable' }, liveRun('no-prov')] });
  const pkg = view('package_boundary', [pkgCap('det'), pkgCap('hitl')], { executions: [pkgRun('ok'), pkgRun('bad-result', { matched: false }), pkgRun('bad-prov', { recorded: { ...rec, contractContentHash: 'other' } }), pkgRun('no-prov', { recorded: undefined })] });
  const u = compareViews('live_vs_package', live, pkg).filter((x) => x.dimension.startsWith('execution'));
  const s = (d: string, id: string) => u.find((x) => x.dimension === d && x.subject === id)?.state;
  assert.equal(s('execution_outcome', 'ok'), 'match'); assert.equal(s('execution_provenance', 'ok'), 'match');
  assert.equal(s('execution_outcome', 'bad-result'), 'mismatch');
  assert.equal(s('execution_provenance', 'bad-prov'), 'mismatch');
  assert.equal(s('execution_outcome', 'no-pkg'), 'not_exercised');
  assert.equal(s('execution_outcome', 'h'), 'not_comparable');
  assert.equal(s('execution_outcome', 'nr'), 'not_exercised');
  assert.equal(s('execution_provenance', 'no-prov'), 'unknown', 'the package did not record provenance');
  assert.equal(u.find((x) => x.dimension === 'execution_provenance' && x.subject === 'ok')!.left!.includes('g1'), false, 'graphHash is excluded from the provenance comparison');
});

test('path-local ids cannot create false mismatches: only content-derived ids are compared, and an extra path-local field (name, order) is ignored', () => {
  const live = view('live_graph', [capV('a', { name: 'Alpha' }), capV('b', { name: 'Beta' })]);
  const ser = view('serialized_graph', [capV('b', { name: 'renamed path-local label' }), capV('a', { name: 'Alpha' })]);
  assert.deepEqual(compareViews('live_vs_serialized', live, ser).filter((x) => x.state !== 'match'), []);
});

// ---- 3. metric integrity -----------------------------------------------------------------------

const withPaths = (paths: PathView[]) => ({ ...observation({}), paths });
const metricOfPaths = (paths: PathView[]) => metricOf(evaluateCase(caseDef({}), withPaths(paths)), 'crossPathConsistency');

test('metric: only match and mismatch enter the denominator; unknown / not_comparable / not_exercised are reported but never pass or fail', () => {
  const live = view('live_graph', [capV('a'), capV('b', { binding: hitl }), capV('c', { binding: { status: 'unresolved' } })]);
  const pkg = view('package_boundary', [pkgCap('a'), pkgCap('b', { binding: { status: 'unresolved' } })]);
  const m = metricOfPaths([live, view('serialized_graph', [capV('a'), capV('b', { binding: hitl }), capV('c', { binding: { status: 'unresolved' } })]), pkg])!;
  const all = [...compareViews('live_vs_serialized', live, view('serialized_graph', live.capabilities.slice())), ...compareViews('live_vs_package', live, pkg)];
  const judgedUnits = all.filter((x) => x.state === 'match' || x.state === 'mismatch');
  assert.equal(m.denominator, judgedUnits.length);
  assert.equal(m.numerator, judgedUnits.filter((x) => x.state === 'match').length);
  const counted = Object.entries(m.breakdown!).reduce((n, [k, v]) => n + v, 0);
  assert.equal(counted, all.length, 'every unit is accounted for in the breakdown');
  assert.ok(Object.keys(m.breakdown!).some((k) => k.endsWith('.not_comparable')));
  for (const k of Object.keys(m.breakdown!)) assert.ok(CROSS_PATH_STATES.includes(k.split('.').pop() as never), k);
});

test('metric: an empty or all-non-judged comparison is ABSENT, never 100%; serialized-XOIR entries (no paths) emit nothing; a missing path is not_exercised, not a failure', () => {
  assert.equal(metricOf(evaluateCase(caseDef({}), observation({})), 'crossPathConsistency'), undefined, 'no paths observed');
  assert.equal(metricOfPaths([view('live_graph', [])]), undefined, 'live only: nothing to compare');
  assert.equal(metricOfPaths([view('live_graph', [capV('x', { binding: { status: 'unresolved' } })], { graphHash: undefined as never }), view('package_boundary', [])]), undefined, 'nothing judged');
  const onlyLive = metricOfPaths([view('live_graph', [capV('a')]), view('serialized_graph', [capV('a')])])!;
  assert.equal(ratio(onlyLive), `${onlyLive.denominator}/${onlyLive.denominator}`);
  assert.equal(onlyLive.breakdown!['live_vs_package.*.not_exercised'], 1, 'the package path was not built => not_exercised, not a failure');
});

test('metric: a mismatch is a listed item with the raw values; micro-average over cases is sum/sum; descriptive; deterministic and order-independent', () => {
  const live = view('live_graph', [capV('a'), capV('b')]);
  const good = view('serialized_graph', [capV('a'), capV('b')]);
  const bad = view('serialized_graph', [capV('a'), capV('b', { contractContentHash: 'tampered' })]);
  const e1 = evaluateCase(caseDef({}, undefined, 'one'), withPaths([live, good])); // all match
  const e2 = evaluateCase(caseDef({}, undefined, 'two'), withPaths([live, bad]));
  const m2 = metricOf(e2, 'crossPathConsistency')!;
  assert.equal(m2.mismatched.length, 1);
  assert.equal(m2.mismatched[0]!.id, 'live_vs_serialized|contract_hash|b');
  assert.match(m2.mismatched[0]!.reason, /"h-b".*"tampered"/);
  const rep = buildReport('s', [e1, e2]);
  const agg = rep.aggregate.metrics.find((x) => x.id === 'crossPathConsistency')!;
  const n1 = metricOf(e1, 'crossPathConsistency')!, n2 = m2;
  assert.equal(agg.numerator, n1.numerator + n2.numerator); assert.equal(agg.denominator, n1.denominator + n2.denominator);
  assert.equal(rep.measured, false, 'descriptive');
  const shuffled = evaluateCase(caseDef({}, undefined, 'two'), withPaths([view('serialized_graph', [capV('b', { contractContentHash: 'tampered' }), capV('a')]), live]));
  assert.equal(canonicalJson(metricOf(shuffled, 'crossPathConsistency')), canonicalJson(m2), 'view order and capability order do not matter');
});

test('registry: the metric is registered as descriptive, the historical set is unchanged, and the reserved crossPathConsistency semantics are now implemented', () => {
  assert.deepEqual([...CROSS_PATH_METRIC_IDS], ['crossPathConsistency']);
  assert.equal(METRIC_MODEL.crossPathConsistency.role, 'descriptive');
  assert.equal(METRIC_MODEL.crossPathConsistency.countsTowardSuiteMeasured, false);
  assert.ok(!HISTORICAL_METRIC_IDS.includes('crossPathConsistency'));
  assert.equal(HISTORICAL_METRIC_IDS.length, 20);
});

// ---- 4. drift guards -----------------------------------------------------------------------------

test('drift guards: the scope constants equal what the compiler / binding resolver actually do', async () => {
  const lowering = await readFile(join(PKG, '..', 'compiler', 'src', 'pipeline', 'capability-lowering.ts'), 'utf8');
  const m = lowering.match(/LOWERABLE_IMPLEMENTATION_CLASSES[^=]*=\s*(?:new Set\()?\[([^\]]+)\]/);
  assert.ok(m, 'LOWERABLE_IMPLEMENTATION_CLASSES found in the compiler');
  assert.deepEqual([...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(), [...LOWERABLE_IMPLEMENTATION_CLASSES].sort());
  const resolver = await readFile(join(PKG, '..', 'capability-contract', 'src', 'structured-comparison-resolver.ts'), 'utf8');
  assert.ok(resolver.includes(INSTALLED_PATH_BINDING_CLASS), 'the structured-comparison resolver binds the deterministic class');
});

// ---- 5. the real pipeline, all 8 cases -------------------------------------------------------------

test('real pipeline (all 8 cases): the three paths are built from the same graph and agree on every judged unit; hand-built XOIR emits no cross-path metric; the observed graph is never mutated', async () => {
  const totals: Record<string, number> = {};
  for (const name of ['vertical-fixtures', 'runtime-mechanics']) {
    const l = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
    assert.ok(l.ok);
    for (const def of l.suite.cases) {
      const obs = await observeCase(def, { sourceRoot: l.sourceRoot });
      const m = metricOf(evaluateCase(def, obs), 'crossPathConsistency');
      if (def.xoir !== undefined) { assert.equal(obs.paths, undefined, `${def.caseId}: runtime-mechanics is not forced into source comparison`); assert.equal(m, undefined); continue; }
      assert.deepEqual(obs.paths!.map((p) => p.path), ['live_graph', 'serialized_graph', 'package_boundary'], def.caseId);
      assert.ok(m, `${def.caseId}: judged units exist`);
      assert.equal(m!.numerator, m!.denominator, `${def.caseId}: ${JSON.stringify(m!.mismatched)}`);
      for (const [k, v] of Object.entries(m!.breakdown!)) totals[k] = (totals[k] ?? 0) + v;
      // the live view is the observation itself
      const live = obs.paths![0]!;
      assert.equal(live.capabilities.length, obs.provenance!.capabilities.length);
      const lowered = obs.paths![2]!;
      assert.equal(lowered.graphIdentity, 'lowered'); assert.equal(lowered.graphHash, undefined, 'the package boundary has no graph hash, by design');
    }
  }
  assert.equal(totals['live_vs_serialized.graph_hash.match'], 7, 'the graph content hash survives a serialization round trip in all 7 compiled cases');
  assert.equal(totals['live_vs_package.graph_hash.not_comparable'], 7, 'never compared across lowering');
  assert.equal(totals['live_vs_package.binding.not_comparable'], 19, 'the by-design HITL scope difference is visible, not hidden');
  assert.equal(totals['live_vs_package.contract_hash.match'], 42, 'every lowered contract equals the live contract');
  assert.equal(Object.entries(totals).filter(([k]) => k.endsWith('.mismatch')).length, 0);
});

test('the package-boundary view is real, not a copy of the live view: tampering with a lowered contract in the observation is detected', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const obs = await observeCase(l.suite.cases.find((c) => c.caseId === 'synthetic-claim-rules')!, { sourceRoot: l.sourceRoot });
  const [live, , pkg] = obs.paths!;
  assert.ok(pkg!.capabilities.some((c) => c.contractEmbedded === true), 'contracts were extracted from the serialized lowered graph');
  const tampered: PathView = { ...pkg!, capabilities: pkg!.capabilities.map((c) => (c.contractEmbedded ? { ...c, contractContentHash: 'tampered' } : c)) };
  assert.ok(compareViews('live_vs_package', live!, tampered).some((u) => u.state === 'mismatch' && u.dimension === 'contract_hash'));
});

test('the package-boundary view is DERIVED from what lowering wrote, not copied from the live view: a corrupting lowering is detected by the metric end to end (kills the "copied hash" mutation)', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const def = l.suite.cases.find((c) => c.caseId === 'synthetic-claim-rules')!;
  let corrupted = 0;
  const corruptingLower: typeof lowerCapabilitiesToManifest = (graph, ...rest) => {
    const result = lowerCapabilitiesToManifest(graph, ...rest);
    for (const n of graph.allNodes()) {
      const contract = (n.properties as Record<string, unknown>)['semanticCapabilityContract'] as Record<string, unknown> | undefined;
      if (n.kind === 'capability' && contract !== undefined && typeof contract['name'] === 'string') { contract['name'] = `${contract['name']} (tampered)`; corrupted++; }
    }
    return result;
  };
  const obs = await observeCase(def, { sourceRoot: l.sourceRoot, lowerCapabilities: corruptingLower });
  assert.ok(corrupted > 0, 'the seam was exercised');
  const m = metricOf(evaluateCase(def, obs), 'crossPathConsistency')!;
  assert.ok(m.mismatched.some((i) => i.id.startsWith('live_vs_package|contract_hash|')), JSON.stringify(m.mismatched));
  assert.ok(m.numerator < m.denominator);
  // the unmodified lowering still agrees (the seam changes nothing by default)
  const clean = metricOf(evaluateCase(def, await observeCase(def, { sourceRoot: l.sourceRoot })), 'crossPathConsistency')!;
  assert.equal(clean.numerator, clean.denominator);
});

test('cross-path views are observation data only: excluded from every stage fingerprint and the observed result is unchanged by building them', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const def = l.suite.cases.find((c) => c.caseId === 'synthetic-claim-rules')!;
  const a = await observeCase(def, { sourceRoot: l.sourceRoot });
  const b = await observeCase(def, { sourceRoot: l.sourceRoot });
  assert.deepEqual(a.fingerprints, b.fingerprints);
  // FINDING (Step 6): a freshly compiled graph's `graphHash` is RUN-SPECIFIC — node / edge `metadata.createdAt` is hashed deliberately as provenance (`updatedAt` is not; see xoir `hashing.ts`).
  // It is stable only for one graph instance and its serialized copies, which is the only scope in which this benchmark compares it. Everything
  // else (capability ids, contract hashes, bindings, executions) is identical across independent compilations.
  const withoutGraphHash = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'graphHash' ? undefined : x)));
  assert.equal(canonicalJson(withoutGraphHash(a.paths)), canonicalJson(withoutGraphHash(b.paths)), 'deterministic apart from the run-specific graph hash');
  // within ONE observation the live and serialized hashes are the same object's hash
  assert.equal(a.paths![0]!.graphHash, a.paths![1]!.graphHash);
});

// silence unused import in strict test configs
void okStages;

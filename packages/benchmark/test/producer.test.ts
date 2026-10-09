import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORICAL_METRIC_IDS,
  KNOWLEDGE_SUBTYPE_KIND,
  METRIC_MODEL,
  PRODUCER_ORIGINS,
  PRODUCER_TAXONOMY,
  REASONING_SUBTYPE_KIND,
  RULE_DERIVED_METADATA_KEY,
  STAMPING_ORIGINS,
  auditExpectationIntegrity,
  buildReport,
  canonicalJson,
  classifyProducerOrigin,
  compareReports,
  evaluateCase,
  loadSuiteFile,
  measurementState,
  observeCase,
  producerValueStatus,
  summarizeProducerAttribution,
  validateSuiteDefinition,
  type ObservedNode,
} from '../src/index.js';
import { cap, caseDef, metricOf, node, observation, okStages } from './helpers.js';
// Drift guards: the compiler's own tables (not exported from its package index, so imported by path).
import { KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND } from '../../compiler/src/xoir/node-kind-mapping.js';
import { REASONING_NODE_TYPE_TO_CANONICAL_KIND } from '../../compiler/src/xoir/reasoning-node-kind-mapping.js';
import { RULE_DERIVED_METADATA_KEY as COMPILER_RULE_DERIVED_KEY } from '../../compiler/src/xoir/rule-capability-linking.js';

/**
 * P0.9C Step 4 — producer attribution. `producedBy` answers ONE question: who created the claim. Nothing here reads source provenance,
 * evidence or runtime provenance (Step 5), and no test introduces an AI variant.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const ratio = (m: { numerator: number; denominator: number } | undefined): string => (m === undefined ? 'absent' : `${m.numerator}/${m.denominator}`);

// ---- builders ---------------------------------------------------------------------------------

const concept = (id: string, producedBy?: string, subtype = 'concept'): ObservedNode => ({ ...node(id, 'concept', {}), subtype, ...(producedBy !== undefined ? { producedBy } : {}) });
const heuristic = (id: string, producedBy?: string): ObservedNode => ({ ...node(id, 'heuristic', {}), subtype: 'rule', ...(producedBy !== undefined ? { producedBy } : {}) });
const capNode = (id: string, producedBy?: string, minted = false): ObservedNode => ({ ...node(id, 'capability', minted ? { metadata: { [RULE_DERIVED_METADATA_KEY]: 'true' } } : {}), ...(producedBy !== undefined ? { producedBy } : {}) });
const expecting = (producedBy: string | undefined) => caseDef({ capabilities: { items: [{ id: 'k', name: { equals: 'Alpha' }, ...(producedBy !== undefined ? { producedBy } : {}) }] } });

// ---- 1. taxonomy --------------------------------------------------------------------------------

test('taxonomy: exactly the values the repository can stamp (rule-based, structured-operation, ai); hybrid is a wrapper name that is never stamped; unknown values are reported verbatim, never normalised', () => {
  assert.deepEqual(PRODUCER_TAXONOMY.map((p) => p.value).sort(), ['ai', 'hybrid', 'rule-based', 'structured-operation']);
  assert.deepEqual(PRODUCER_TAXONOMY.filter((p) => p.stamped).map((p) => p.value).sort(), ['ai', 'rule-based', 'structured-operation']);
  assert.equal(producerValueStatus('rule-based'), 'known');
  for (const unknown of ['hybrid', 'Rule-Based', 'rule_based', 'concept', 'heuristic', 'decision_node', '']) assert.equal(producerValueStatus(unknown), 'unknown', JSON.stringify(unknown));
  // No normalisation: a differently-cased producer is a different producer, so an expectation for it is a mismatch, not a match.
  const ev = evaluateCase(expecting('rule-based'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', 'Rule-Based')] }));
  assert.equal(ratio(metricOf(ev, 'producerAttributionCorrectness')), '0/1');
});

test('taxonomy drift guard: every stamped value is a real extractor `.name` in the compiler, `hybrid` exists as a wrapper name, and the node-kind / rule-derived tables equal the compiler\'s own', async () => {
  const names = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.ts')) for (const m of (await readFile(p, 'utf8')).matchAll(/readonly name\s*=\s*'([^']+)'/g)) names.add(m[1]!);
    }
  };
  await walk(join(PKG, '..', 'compiler', 'src'));
  for (const p of PRODUCER_TAXONOMY) assert.ok(names.has(p.value), `${p.value} is an extractor name in the compiler`);
  assert.deepEqual({ ...KNOWLEDGE_SUBTYPE_KIND }, { ...KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND });
  assert.deepEqual({ ...REASONING_SUBTYPE_KIND }, { ...REASONING_NODE_TYPE_TO_CANONICAL_KIND });
  assert.equal(RULE_DERIVED_METADATA_KEY, COMPILER_RULE_DERIVED_KEY);
});

test('classification is decided from kind, subtype and the minter marker only — never from producedBy — and is deterministic', () => {
  for (const producedBy of [undefined, 'rule-based', 'ai', 'anything']) {
    assert.equal(classifyProducerOrigin({ ...concept('a'), ...(producedBy ? { producedBy } : {}) }), 'knowledge_extractor');
    assert.equal(classifyProducerOrigin({ ...heuristic('h'), ...(producedBy ? { producedBy } : {}) }), 'reasoning_extractor');
    assert.equal(classifyProducerOrigin({ ...capNode('c'), ...(producedBy ? { producedBy } : {}) }), 'capability_extractor');
    assert.equal(classifyProducerOrigin({ ...capNode('m', undefined, true), ...(producedBy ? { producedBy } : {}) }), 'rule_minted_capability');
  }
  const constraint = (subtype: string): ObservedNode => ({ ...node('x', 'constraint', {}), subtype });
  for (const s of ['constraint', 'obligation', 'exception']) assert.equal(classifyProducerOrigin(constraint(s)), 'knowledge_extractor', s);
  for (const s of ['prerequisite', 'prohibition', 'policy']) assert.equal(classifyProducerOrigin(constraint(s)), 'reasoning_extractor', s);
  assert.equal(classifyProducerOrigin({ ...node('x', 'heuristic', {}), subtype: 'exception' }), 'reasoning_extractor', '`exception` is in both pipelines; the KIND disambiguates');
  assert.equal(classifyProducerOrigin({ ...node('x', 'constraint', {}), subtype: 'exception' }), 'knowledge_extractor');
  assert.equal(classifyProducerOrigin(node('x', 'concept', {})), 'unclassified', 'no subtype => unclassified, never guessed');
  assert.equal(classifyProducerOrigin({ ...node('x', 'concept', {}), subtype: 'no-such-type' }), 'unclassified');
  assert.equal(classifyProducerOrigin({ ...node('x', 'heuristic', {}), subtype: 'concept' }), 'unclassified', 'a subtype from the other pipeline on the wrong kind is unclassified');
  assert.deepEqual([...PRODUCER_ORIGINS], ['knowledge_extractor', 'capability_extractor', 'rule_minted_capability', 'reasoning_extractor', 'unclassified']);
  assert.deepEqual([...STAMPING_ORIGINS], ['knowledge_extractor', 'capability_extractor']);
  // no (kind, subtype) pair is claimed by both pipelines
  for (const [sub, kk] of Object.entries(KNOWLEDGE_SUBTYPE_KIND)) if (sub in REASONING_SUBTYPE_KIND) assert.notEqual(REASONING_SUBTYPE_KIND[sub], kk, `${sub}: the two pipelines must map the shared subtype to different kinds`);
});

// ---- 2. coverage --------------------------------------------------------------------------------

test('coverage: attributed nodes count; MISSING attribution on a stamping path is measured as missing; reasoning-derived and rule-minted nodes are not judged (and are reported, not hidden)', () => {
  const nodes = [
    concept('a', 'rule-based'), concept('b', 'rule-based'), concept('c'), // c: stamping path, absent => missing
    capNode('k1', 'structured-operation'), capNode('k2'), // k2: extractor capability without a producer => missing
    capNode('m1', undefined, true), // rule-minted: not judged
    heuristic('h1'), { ...node('d', 'decision_node', {}), subtype: 'decision' }, // reasoning-derived: not judged
    node('u', 'fact', {}), // no subtype: unclassified, not judged
  ];
  const ev = evaluateCase(caseDef({}), observation({ nodes }));
  const m = metricOf(ev, 'producerAttributionCoverage')!;
  assert.equal(ratio(m), '3/5');
  assert.deepEqual(m.missing.map((i) => i.id).sort(), ['capability|k2', 'concept|c']);
  assert.deepEqual(m.breakdown, {
    'in_population.capability_extractor.attributed': 1,
    'in_population.capability_extractor.unattributed': 1,
    'in_population.knowledge_extractor.attributed': 2,
    'in_population.knowledge_extractor.unattributed': 1,
    'not_judged.reasoning_extractor.unattributed': 2,
    'not_judged.rule_minted_capability.unattributed': 1,
    'not_judged.unclassified.unattributed': 1,
  });
  assert.equal(m.denominator - m.numerator, m.missing.length, 'every failed unit is listed');
});

test('coverage never penalises legitimate absence: a case with only reasoning-derived / rule-minted / unclassified nodes has NO coverage metric (not applicable), never 0%', () => {
  const ev = evaluateCase(caseDef({}), observation({ nodes: [heuristic('h'), capNode('m', undefined, true), node('u', 'fact', {})] }));
  assert.equal(metricOf(ev, 'producerAttributionCoverage'), undefined);
  assert.equal(measurementState(metricOf(ev, 'producerAttributionCoverage')), 'not_applicable');
  assert.equal(metricOf(evaluateCase(caseDef({}), observation({ nodes: [] })), 'producerAttributionCoverage'), undefined);
});

test('coverage is not observable without a compile: serialized-XOIR entries and failed compiles emit no producer metric (attribution is a property of a compile, not of a hand-built graph)', () => {
  for (const status of ['skipped', 'failed'] as const) {
    const stages = okStages({ compile: { stage: 'compile', status, ...(status === 'failed' ? { error: { code: 'X', message: 'm' } } : { note: 'serialized XOIR entry' }) } as never });
    const ev = evaluateCase(caseDef({}), observation({ nodes: [concept('a')], stages }));
    assert.equal(metricOf(ev, 'producerAttributionCoverage'), undefined, status);
  }
});

test('coverage is descriptive for `measured`: it makes no expectation-free suite count as measured, exactly like observedSourceRefCoverage', () => {
  const ev = evaluateCase(caseDef({}), observation({ nodes: [concept('a', 'rule-based')] }));
  assert.ok(metricOf(ev, 'producerAttributionCoverage'));
  assert.equal(buildReport('s', [ev]).measured, false);
  assert.equal(METRIC_MODEL.producerAttributionCoverage.countsTowardSuiteMeasured, false);
  assert.equal(METRIC_MODEL.producerAttributionCorrectness.countsTowardSuiteMeasured, true);
});

// ---- 3. correctness -----------------------------------------------------------------------------

test('correctness: a correct producer passes; a wrong producer is a mismatch and marks the item incorrect — and changes no HISTORICAL metric', () => {
  const obs = (producedBy: string) => observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', producedBy)] });
  const good = evaluateCase(expecting('structured-operation'), obs('structured-operation'));
  assert.equal(ratio(metricOf(good, 'producerAttributionCorrectness')), '1/1');
  assert.deepEqual(good.items.map((i) => i.outcome), ['found']);

  const bad = evaluateCase(expecting('structured-operation'), obs('rule-based'));
  const m = metricOf(bad, 'producerAttributionCorrectness')!;
  assert.equal(ratio(m), '0/1');
  assert.deepEqual(m.mismatched.map((i) => i.id), ['k']);
  assert.match(m.mismatched[0]!.reason, /expected producedBy "structured-operation", got "rule-based"/);
  assert.deepEqual(bad.items.map((i) => i.outcome), ['incorrect']);

  const plain = evaluateCase(expecting(undefined), obs('rule-based'));
  const hist = (e: typeof bad) => canonicalJson(e.metrics.filter((x) => HISTORICAL_METRIC_IDS.includes(x.id)));
  assert.equal(hist(bad), hist(plain), 'a wrong producer changes no historical metric (capabilityRecall counts identity only)');
  assert.equal(hist(good), hist(plain));
});

test('correctness is ABSENT, never 0%, when nothing is asserted; an expectation on an unlocated capability is not counted (L4) — that is recall\'s miss', () => {
  const obs = observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', 'rule-based')] });
  assert.equal(metricOf(evaluateCase(expecting(undefined), obs), 'producerAttributionCorrectness'), undefined);
  const unlocated = evaluateCase(expecting('rule-based'), observation({ capabilities: [], nodes: [] }));
  assert.equal(metricOf(unlocated, 'producerAttributionCorrectness'), undefined);
  assert.equal(ratio(metricOf(unlocated, 'capabilityRecall')), '0/1');
});

test('ambiguous / unmeasurable producers are excluded, not forced: expectation on a rule-minted capability (another path), or on a capability with no observed producer (coverage\'s question)', () => {
  const minted = evaluateCase(expecting('rule-based'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', undefined, true)] }));
  assert.equal(metricOf(minted, 'producerAttributionCorrectness'), undefined, 'premise not met: a minted capability has no extractor');
  assert.equal(minted.items[0]!.outcome, 'found', 'and it is not an item failure');

  // isolates the PREMISE guard: a minted capability that (hypothetically) carries a producer is still created by another path, so neither a
  // matching nor a differing expected producer may be scored against it.
  for (const carried of ['rule-based', 'something-else']) {
    const carriedMinted = evaluateCase(expecting('rule-based'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', carried, true)] }));
    assert.equal(metricOf(carriedMinted, 'producerAttributionCorrectness'), undefined, `premise not met (carried ${carried})`);
    assert.equal(carriedMinted.items[0]!.outcome, 'found');
  }

  const absent = evaluateCase(expecting('rule-based'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1')] }));
  assert.equal(metricOf(absent, 'producerAttributionCorrectness'), undefined, 'absence is not a WRONG producer');
  const cov = metricOf(absent, 'producerAttributionCoverage')!;
  assert.equal(ratio(cov), '0/1', 'it is measured as missing by coverage, exactly once');
  assert.equal(absent.items[0]!.outcome, 'found');

  const noNode = evaluateCase(expecting('rule-based'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [] }));
  assert.equal(metricOf(noNode, 'producerAttributionCorrectness'), undefined);
});

test('an expected producer outside the real taxonomy is rejected by the integrity lint (it could never be satisfied); the definition validator accepts only non-empty strings', () => {
  const ok = validateSuiteDefinition({ schemaVersion: 1, suiteId: 's', sourceRoot: '.', cases: [{ caseId: 'c', sources: [{ kind: 'document', path: 'x.txt' }], expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, producedBy: 'rule-based' }] } } }] });
  assert.ok(ok.ok);
  const bad = (producedBy: unknown) => validateSuiteDefinition({ schemaVersion: 1, suiteId: 's', sourceRoot: '.', cases: [{ caseId: 'c', sources: [{ kind: 'document', path: 'x.txt' }], expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, producedBy }] } } }] });
  for (const v of ['', 7, null, ['a']]) assert.equal(bad(v).ok, false, JSON.stringify(v));
  const unknown = validateSuiteDefinition({ schemaVersion: 1, suiteId: 's', sourceRoot: '.', cases: [{ caseId: 'c', sources: [{ kind: 'document', path: 'x.txt' }], expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, producedBy: 'concept' }] } } }] });
  assert.ok(unknown.ok);
  assert.deepEqual(auditExpectationIntegrity(unknown.ok ? unknown.value : (undefined as never)).map((f) => f.code), ['unknown_expected_producer']);
  assert.deepEqual(auditExpectationIntegrity(ok.ok ? ok.value : (undefined as never)), []);
});

// ---- 4. evaluation integrity --------------------------------------------------------------------

test('micro-average: aggregate coverage and correctness are sums of numerators over sums of denominators (not a mean of ratios); absent cases do not dilute', () => {
  const a = evaluateCase(caseDef({}, undefined, 'a'), observation({ nodes: [concept('1', 'rule-based'), concept('2')] })); // 1/2
  const b = evaluateCase(caseDef({}, undefined, 'b'), observation({ nodes: [concept('3', 'rule-based'), concept('4', 'rule-based'), concept('5', 'rule-based'), concept('6', 'rule-based')] })); // 4/4
  const none = evaluateCase(caseDef({}, undefined, 'n'), observation({ nodes: [heuristic('h')] })); // absent
  const agg = buildReport('s', [a, b, none]).aggregate.metrics.find((m) => m.id === 'producerAttributionCoverage')!;
  assert.equal(ratio(agg), '5/6');
  assert.notEqual(agg.ratio, (0.5 + 1) / 2);
  assert.deepEqual(agg.missing.map((i) => `${i.caseId}:${i.id}`), ['a:concept|2']);
  assert.equal(agg.breakdown!['in_population.knowledge_extractor.attributed'], 5, 'breakdown counts are summed');

  const c1 = evaluateCase(expecting('structured-operation'), observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', 'structured-operation')] }));
  const c2 = evaluateCase({ ...expecting('structured-operation'), caseId: 'two' }, observation({ capabilities: [cap('c1', 'Alpha')], nodes: [capNode('c1', 'rule-based')] }));
  assert.equal(ratio(buildReport('s', [c1, c2]).aggregate.metrics.find((m) => m.id === 'producerAttributionCorrectness')), '1/2');
});

test('0/0 stays unmeasured and absence stays absent after aggregation: the producer metrics never become 0% or 100% by default', () => {
  const r = buildReport('s', [evaluateCase(caseDef({}), observation({ nodes: [heuristic('h')] }))]);
  assert.equal(r.aggregate.metrics.some((m) => m.id === 'producerAttributionCoverage' || m.id === 'producerAttributionCorrectness'), false);
});

test('open world is preserved: a producer expectation adds no precision metric, no unexpected item, and never closes a world', () => {
  const def = expecting('rule-based');
  const ev = evaluateCase(def, observation({ capabilities: [cap('c1', 'Alpha'), cap('c2', 'Unlisted')], nodes: [capNode('c1', 'rule-based'), capNode('c2', 'rule-based')] }));
  assert.equal(metricOf(ev, 'capabilityPrecision'), undefined);
  assert.equal(ev.items.filter((i) => i.outcome === 'unexpected').length, 0);
  assert.equal(def.expect.capabilities?.closedWorld, undefined);
  // closed world: unexpected capabilities stay judged by capabilityPrecision only, independent of producer attribution
  const closed = evaluateCase(caseDef({ capabilities: { closedWorld: true, items: [{ id: 'k', name: { equals: 'Alpha' }, producedBy: 'rule-based' }] } }), observation({ capabilities: [cap('c1', 'Alpha'), cap('c2', 'Unlisted')], nodes: [capNode('c1', 'rule-based'), capNode('c2', 'rule-based')] }));
  assert.equal(ratio(metricOf(closed, 'capabilityPrecision')), '1/2');
  assert.equal(ratio(metricOf(closed, 'producerAttributionCorrectness')), '1/1', 'the unexpected capability has no producer expectation, so it is not asserted');
});

test('producer evaluation is pure and deterministic: frozen inputs, identical bytes, node order irrelevant', () => {
  const nodes = [concept('a', 'rule-based'), concept('b'), capNode('k', 'structured-operation'), heuristic('h'), capNode('m', undefined, true)];
  const freeze = <T,>(v: T): T => { if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) freeze(x); } return v; };
  const def = expecting('structured-operation');
  const plain = evaluateCase(def, observation({ capabilities: [cap('k', 'Alpha')], nodes }));
  const frozen = evaluateCase(freeze(expecting('structured-operation')), freeze(observation({ capabilities: [cap('k', 'Alpha')], nodes: [...nodes] })));
  assert.equal(canonicalJson(plain), canonicalJson(frozen));
  const shuffled = evaluateCase(def, observation({ capabilities: [cap('k', 'Alpha')], nodes: [...nodes].reverse() }));
  const pick = (e: typeof plain) => canonicalJson(e.metrics);
  assert.equal(pick(shuffled), pick(plain));
  assert.equal(canonicalJson(summarizeProducerAttribution(nodes)), canonicalJson(summarizeProducerAttribution([...nodes].reverse())));
});

test('regression: the 20 historical metrics keep their registry stage / emission / definition; the two new metrics are registered in their own dimension and nothing else was added', () => {
  assert.equal(HISTORICAL_METRIC_IDS.length, 20);
  for (const id of ['producerAttributionCoverage', 'producerAttributionCorrectness'] as const) assert.equal(METRIC_MODEL[id].dimension, 'producer_attribution');
  for (const id of HISTORICAL_METRIC_IDS) assert.notEqual(METRIC_MODEL[id].dimension, 'producer_attribution');
  // a report without any producer expectation/metric compares cleanly against itself: no finding, no warning
  const r = buildReport('s', [evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({}))]);
  assert.equal(compareReports(r, r).classification, 'no_change');
});

// ---- 5. the real pipeline, all 8 cases -----------------------------------------------------------

test('real pipeline (all 8 committed cases): no node is unclassified; every attributed node is on a stamping path (reasoning / rule-minted nodes are NEVER attributed today); stamped values are known; coverage is complete where judged', async () => {
  const seenProducers = new Map<string, Set<string>>();
  for (const name of ['vertical-fixtures', 'runtime-mechanics']) {
    const l = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
    assert.ok(l.ok);
    for (const def of l.suite.cases) {
      const obs = await observeCase(def, { sourceRoot: l.sourceRoot });
      const s = summarizeProducerAttribution(obs.nodes);
      const hand = obs.stages.compile.status !== 'ok';
      if (hand) {
        assert.equal(metricOf(evaluateCase(def, obs), 'producerAttributionCoverage'), undefined, `${def.caseId}: hand-built XOIR => not observable`);
        continue;
      }
      assert.equal(s.unclassified.attributed + s.unclassified.unattributed, 0, `${def.caseId}: every node is classified`);
      for (const o of ['reasoning_extractor', 'rule_minted_capability'] as const) assert.equal(s[o].attributed, 0, `${def.caseId}: ${o} carries no producer today (L12)`);
      for (const o of STAMPING_ORIGINS) assert.equal(s[o].unattributed, 0, `${def.caseId}: ${o} fully attributed`);
      for (const n of obs.nodes) if (n.producedBy !== undefined) {
        assert.equal(producerValueStatus(n.producedBy), 'known', `${def.caseId}: ${n.producedBy}`);
        seenProducers.set(n.producedBy, (seenProducers.get(n.producedBy) ?? new Set()).add(def.caseId));
      }
      // knowledge nodes are created by the knowledge extractor: rule-based (AI not exercised)
      assert.deepEqual(Object.keys(s.knowledge_extractor.producers), s.knowledge_extractor.attributed > 0 ? ['rule-based'] : [], def.caseId);
      const structured = def.sources.some((x) => x.kind === 'structured' || x.kind === 'openapi');
      assert.deepEqual(Object.keys(s.capability_extractor.producers).sort(), structured ? ['structured-operation'] : s.capability_extractor.attributed > 0 ? ['rule-based'] : [], def.caseId);
    }
  }
  // the taxonomy's `exercisedBy` is what the pipeline actually does
  for (const p of PRODUCER_TAXONOMY) assert.deepEqual([...(seenProducers.get(p.value) ?? [])].sort(), [...p.exercisedBy], p.value);
});

test('the four committed golden producer assertions hold on the real pipeline (structured / OpenAPI operations are produced by the structured-operation extractor)', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  let asserted = 0;
  for (const def of l.suite.cases) {
    const items = (def.expect.capabilities?.items ?? []).filter((k) => k.producedBy !== undefined);
    if (items.length === 0) continue;
    asserted += items.length;
    assert.ok(def.sources.every((s) => s.kind === 'structured' || s.kind === 'openapi'), `${def.caseId}: producer asserted only where the source format determines the extractor`);
    const ev = evaluateCase(def, await observeCase(def, { sourceRoot: l.sourceRoot }));
    assert.equal(ratio(metricOf(ev, 'producerAttributionCorrectness')), `${items.length}/${items.length}`);
  }
  assert.equal(asserted, 4);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIMENSIONS,
  HISTORICAL_METRIC_IDS,
  KNOWN_LIMITATIONS,
  PRODUCER_METRIC_IDS,
  PROVENANCE_METRIC_IDS,
  METRIC_IDS,
  METRIC_MODEL,
  RESERVED_DIMENSIONS,
  buildReport,
  canonicalJson,
  compareReports,
  evaluateCase,
  interpretCase,
  measurementState,
  parseReport,
  stageObservability,
  type BenchmarkReport,
  type CaseExpectations,
  type CaseEvaluation,
  type ExecutionCase,
  type MetricId,
  type MetricResult,
} from '../src/index.js';
import { cap, caseDef, metricOf, node, observation, okStages, param, wf } from './helpers.js';

/**
 * P0.9C Step 2 — the evaluation MODEL. These tests pin what the numbers
 * MEAN (denominator populations, unmeasured vs not-applicable, open vs
 * closed world, micro-averaging, warnings vs metrics, population changes,
 * purity). They add no metric and change no historical definition; the
 * historical definition text is already pinned in `attribution.test.ts`.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const ratio = (m: MetricResult | undefined): string => (m === undefined ? 'absent' : `${m.numerator}/${m.denominator}=${m.ratio}`);

// ---- fixtures ---------------------------------------------------------------------------------

const ruleFact = { id: 'f1', kind: 'decision_node', identify: [{ path: 'question', contains: 'amount exceeds 10000' }], assert: [{ path: 'outcome', contains: 'deny' }] };
const ruleNode = (id = 'n1', props: Record<string, unknown> = {}) => node(id, 'decision_node', { question: 'the claim amount exceeds 10000', outcome: 'deny the claim', ...props }, { pages: [1] });

/** A case that declares EVERY kind of expectation the evaluator understands. */
const EVERYTHING: CaseExpectations = {
  compile: { outcome: 'succeeds' },
  semantics: { facts: [ruleFact], closedWorldKinds: ['decision_node'], forbidden: [{ id: 'nf', kind: 'decision_node', identify: [{ path: 'question', contains: 'forbidden' }] }] },
  capabilities: {
    closedWorld: true,
    items: [
      { id: 'k-alpha', name: { equals: 'Alpha' }, resolution: 'resolved', executionClass: 'deterministic_rule', inputs: ['x'], outputs: ['y'], evidence: { minSourceRefs: 1 } },
      { id: 'k-beta', name: { equals: 'Beta' } },
    ],
    forbidden: [{ id: 'nk', name: { equals: 'Trap' } }],
  },
  workflows: {
    closedWorld: true,
    items: [
      {
        id: 'w1',
        steps: [{ equals: 'Alpha' }, { equals: 'Beta' }],
        ordered: true,
        executability: 'executable_candidate',
        stepClasses: ['deterministic_rule', 'deterministic_rule'],
        dataFlow: { bindings: [{ producer: { equals: 'Alpha' }, output: 'y', consumer: { equals: 'Beta' }, input: 'x', status: 'proven' }] },
      },
    ],
  },
};
const EVERYTHING_EXEC: ExecutionCase[] = [
  { id: 'run-cap', kind: 'capability', target: { equals: 'Alpha' }, expect: { outcome: 'succeeded' } },
  { id: 'run-wf', kind: 'workflow', steps: [{ equals: 'Alpha' }, { equals: 'Beta' }], expect: { status: 'completed', injections: [{ producer: { equals: 'Alpha' }, output: 'y', consumer: { equals: 'Beta' }, input: 'x' }] } },
];
const everythingDef = () => caseDef(EVERYTHING, EVERYTHING_EXEC);

const binding = { producerCapabilityId: 'cA', producerName: 'Alpha', output: 'y', consumerCapabilityId: 'cB', consumerName: 'Beta', input: 'x', status: 'proven', wired: true };
/** Everything declared by EVERYTHING is produced and satisfied. */
function completeObservation() {
  return observation({
    nodes: [ruleNode()],
    capabilities: [cap('cA', 'Alpha', { inputs: [param('x')], outputs: [param('y')] }), cap('cB', 'Beta', { inputs: [param('x')] })],
    workflows: [wf('w', [['cA', 'Alpha'], ['cB', 'Beta']], { bindings: [binding] as never })],
    executions: [
      { requestId: 'run-cap', kind: 'capability', outcome: 'succeeded' },
      {
        requestId: 'run-wf',
        kind: 'workflow',
        outcome: 'ran',
        runStatus: 'completed',
        steps: [
          { capabilityId: 'cA', name: 'Alpha', engineStepStatus: 'completed', output: { y: 1 }, actualInput: {} },
          { capabilityId: 'cB', name: 'Beta', engineStepStatus: 'completed', output: {}, actualInput: { x: 1 } },
        ],
      },
    ],
  });
}

// ---- 1. the registry describes the metrics that exist ----------------------------------------

test('the registry covers the 20 historical metric ids plus exactly the 2 Step 4 producer metrics, keyed by their own id, with a stage that matches what the evaluator emits (checked against both committed baselines)', async () => {
  assert.equal(HISTORICAL_METRIC_IDS.length, 20);
  assert.deepEqual([...PRODUCER_METRIC_IDS], ['producerAttributionCorrectness', 'producerAttributionCoverage']);
  assert.deepEqual([...PROVENANCE_METRIC_IDS], ['executionProvenanceAgreement', 'provenanceChainCoverage']);
  assert.equal(METRIC_IDS.length, 25, '20 historical + 2 Step 4 + 2 Step 5 + 1 Step 6');
  for (const id of METRIC_IDS) assert.equal(METRIC_MODEL[id].id, id);
  const seen = new Set<MetricId>();
  for (const name of ['vertical-fixtures', 'runtime-mechanics']) {
    // the pre-Step-4 metric set stays pinned by the retained historical predecessors (the accepted baselines are the current output)
    const archived = (await readdir(join(PKG, 'baselines', 'archive'))).find((f) => f.startsWith(`${name}.`));
    assert.ok(archived !== undefined, name);
    const parsed = parseReport(JSON.parse(await readFile(join(PKG, 'baselines', 'archive', archived), 'utf8')));
    assert.ok(parsed.ok);
    for (const m of parsed.value.aggregate.metrics) {
      seen.add(m.id);
      assert.equal(METRIC_MODEL[m.id].stage, m.stage, `${m.id}: registry stage equals the evaluator's stage`);
    }
  }
  assert.deepEqual([...seen].sort(), [...HISTORICAL_METRIC_IDS], 'the two committed (pre-Step-4) baselines together exercise every HISTORICAL metric and no other');
  for (const model of Object.values(METRIC_MODEL)) for (const l of model.limitations) assert.ok(l in KNOWN_LIMITATIONS, `${model.id} cites unknown limitation ${l}`);
});

test('emission rules in the registry are what the evaluator actually does: declared-but-empty (0/0) vs absent, in the "declared everything, produced nothing" case', () => {
  const ev = evaluateCase(everythingDef(), observation({}));
  const present = new Set(ev.metrics.map((m) => m.id));

  // Every `when_declared` metric is present, even where nothing could be evaluated.
  for (const model of Object.values(METRIC_MODEL).filter((m) => m.emission === 'when_declared')) assert.ok(present.has(model.id), `${model.id} present when its expectation kind is declared`);

  // Every conditional-on-upstream `when_measured` metric is ABSENT (not applicable): its upstream item was never located.
  for (const model of Object.values(METRIC_MODEL).filter((m) => m.emission === 'when_measured' && m.conditionalOnUpstream)) assert.ok(!present.has(model.id), `${model.id} absent when its upstream item is not located`);

  // The present-but-unmeasured set is exactly what the registry predicts.
  const predictedUnmeasured = Object.values(METRIC_MODEL)
    .filter((m) => m.emission === 'when_declared' && (m.conditionalOnUpstream || m.world === 'closed_world_only'))
    .map((m) => m.id)
    .sort();
  const actualUnmeasured = ev.metrics.filter((m) => measurementState(m) === 'unmeasured').map((m) => m.id).sort();
  assert.deepEqual(actualUnmeasured, predictedUnmeasured);
  assert.deepEqual(actualUnmeasured, ['capabilityPrecision', 'semanticCorrectness', 'semanticPrecision', 'workflowPrecision']);

  // The descriptive metric needs an observable graph.
  assert.ok(!present.has('observedSourceRefCoverage'));
});

test('when everything declared is produced and satisfied, every historical metric is present and measured — the registry spans all 20 (the Step 4 producer metrics need a producer expectation / stamping-path nodes, which this fixture has none of)', () => {
  const ev = evaluateCase(everythingDef(), completeObservation());
  assert.deepEqual(ev.metrics.map((m) => m.id).sort(), [...HISTORICAL_METRIC_IDS]);
  for (const m of ev.metrics) {
    assert.equal(measurementState(m), 'measured', m.id);
    assert.equal(m.ratio, 1, `${m.id}: ${ratio(m)} ${JSON.stringify([...m.missing, ...m.unexpected, ...m.mismatched])}`);
    const model = METRIC_MODEL[m.id];
    assert.equal(model.stage, m.stage);
  }
});

// ---- 2. denominators --------------------------------------------------------------------------

test('denominator populations: recall counts every expected item; conditional metrics count only located ones; precision counts every observed item in a closed scope', () => {
  // Expected: A (found, correct), B (found, wrong class), C (never discovered). Discovered: A, B, D (unclaimed).
  const ev = evaluateCase(
    caseDef({
      capabilities: {
        closedWorld: true,
        items: [
          { id: 'kA', name: { equals: 'A' }, resolution: 'resolved', executionClass: 'deterministic_rule' },
          { id: 'kB', name: { equals: 'B' }, executionClass: 'deterministic_rule' },
          { id: 'kC', name: { equals: 'C' }, resolution: 'resolved', executionClass: 'deterministic_rule' },
        ],
      },
    }),
    observation({ capabilities: [cap('a', 'A'), cap('b', 'B', { executionClass: 'human_in_the_loop' }), cap('d', 'D')] }),
  );
  assert.equal(ratio(metricOf(ev, 'capabilityRecall')), '2/3=0.666667', 'recall: denominator = expected (C stays in it as a miss)');
  assert.equal(ratio(metricOf(ev, 'capabilityPrecision')), '2/3=0.666667', 'precision: denominator = discovered (D is a false positive)');
  assert.equal(ratio(metricOf(ev, 'executionClassAccuracy')), '1/2=0.5', 'class: denominator = located items with an expected class — C is NOT counted (L4)');
  assert.equal(ratio(metricOf(ev, 'resolutionAccuracy')), '1/1=1', 'resolution: only A among the located declares a resolution');
  for (const id of ['capabilityRecall', 'capabilityPrecision', 'executionClassAccuracy']) {
    const m = metricOf(ev, id)!;
    assert.equal(m.denominator - m.numerator, 1, `${id}: failed count = denominator − numerator`);
  }
  assert.deepEqual(metricOf(ev, 'capabilityRecall')!.missing.map((i) => i.id), ['kC']);
  assert.deepEqual(metricOf(ev, 'capabilityPrecision')!.unexpected.map((i) => i.id), ['capability|d']);
  assert.deepEqual(metricOf(ev, 'executionClassAccuracy')!.mismatched.map((i) => i.id), ['kB']);
});

test('execution metrics are UNCONDITIONAL: a request that was not run stays in the denominator; compile-side assertions on an unlocated item do not', () => {
  const ev = evaluateCase(everythingDef(), observation({}));
  assert.equal(ratio(metricOf(ev, 'executionCorrectness')), '0/2=0', 'two requests, neither run');
  assert.equal(ratio(metricOf(ev, 'runtimeDataFlowTransfer')), '0/1=0', 'the expected injection counts although the workflow never ran');
  assert.equal(metricOf(ev, 'dataFlowCorrectness'), undefined, 'the same binding, asserted at the workflow stage, is not counted: its workflow was not found');
  assert.deepEqual(ev.items.filter((i) => i.dimension === 'execution').map((i) => i.outcome), ['not_run', 'not_run']);
});

test('zero denominators: 0/N (measured, entirely failing) is not 0/0 (unmeasured) is not absent (not applicable)', () => {
  const ev = evaluateCase(everythingDef(), observation({}));
  const zeroOverN = metricOf(ev, 'capabilityRecall')!;
  assert.deepEqual([zeroOverN.numerator, zeroOverN.denominator, zeroOverN.ratio, measurementState(zeroOverN)], [0, 2, 0, 'measured']);
  const zeroOverZero = metricOf(ev, 'capabilityPrecision')!;
  assert.deepEqual([zeroOverZero.numerator, zeroOverZero.denominator, zeroOverZero.ratio, measurementState(zeroOverZero)], [0, 0, null, 'unmeasured']);
  const absent = metricOf(ev, 'resolutionAccuracy');
  assert.equal(absent, undefined);
  assert.equal(measurementState(absent), 'not_applicable');
  // A case that declares nothing at all reports nothing at all — no metric is fabricated.
  assert.deepEqual(evaluateCase(caseDef({}), observation({ nodes: [ruleNode()] })).metrics.map((m) => m.id), ['observedSourceRefCoverage']);
});

test('the "declared but nothing to evaluate" state survives aggregation as null, never as 0 or 1', () => {
  const unmeasuredA = evaluateCase(caseDef({ capabilities: { closedWorld: true, items: [] } }, undefined, 'a'), observation({}));
  const unmeasuredB = evaluateCase(caseDef({ capabilities: { closedWorld: true, items: [] } }, undefined, 'b'), observation({}));
  const agg = buildReport('s', [unmeasuredA, unmeasuredB]).aggregate.metrics.find((m) => m.id === 'capabilityPrecision')!;
  assert.deepEqual([agg.numerator, agg.denominator, agg.ratio, measurementState(agg)], [0, 0, null, 'unmeasured']);
  assert.equal(buildReport('s', [unmeasuredA, unmeasuredB]).measured, false, 'a suite whose every metric is unmeasured measured nothing');
});

// ---- 3. open world vs closed world ------------------------------------------------------------

test('open world: unclaimed output is neither unexpected nor a false positive, no precision is emitted, and forbidden traps are still judged', () => {
  const observed = observation({
    nodes: [ruleNode('n1'), ruleNode('n2', { question: 'something the golden list never mentioned' })],
    capabilities: [cap('c1', 'Alpha'), cap('c2', 'Unlisted'), cap('c3', 'Trap')],
    workflows: [wf('w', [['c1', 'Alpha']])],
  });
  const open = evaluateCase(
    caseDef({
      semantics: { facts: [ruleFact], forbidden: [{ id: 'nf', kind: 'decision_node', identify: [{ path: 'question', contains: 'never mentioned' }] }] },
      capabilities: { items: [{ id: 'k', name: { equals: 'Alpha' } }], forbidden: [{ id: 'nk', name: { equals: 'Trap' } }] },
      workflows: { items: [{ id: 'w1', steps: [{ equals: 'Alpha' }] }] },
    }),
    observed,
  );
  for (const id of ['semanticPrecision', 'capabilityPrecision', 'workflowPrecision']) assert.equal(metricOf(open, id), undefined, `${id}: not emitted without a declared closed world`);
  assert.equal(open.items.filter((i) => i.outcome === 'unexpected').length, 0, 'nothing is "unexpected" in an open world');
  assert.equal(ratio(metricOf(open, 'capabilityRecall')), '1/1=1');
  assert.equal(ratio(metricOf(open, 'spuriousCapabilityAvoidance')), '0/1=0', 'an explicit forbidden trap is judged even in an open world');
  assert.equal(ratio(metricOf(open, 'spuriousFactAvoidance')), '0/1=0', 'a forbidden fact is judged even in an open world');
});

test('closed world: the SAME observation now yields precision and unexpected items — but only for the scopes the author declared closed', () => {
  const observed = observation({
    nodes: [ruleNode('n1'), ruleNode('n2', { question: 'something the golden list never mentioned' }), node('n3', 'concept', { name: 'not in a closed kind' })],
    capabilities: [cap('c1', 'Alpha'), cap('c2', 'Unlisted')],
  });
  const closed = evaluateCase(
    caseDef({
      semantics: { facts: [ruleFact], closedWorldKinds: ['decision_node'] },
      capabilities: { closedWorld: true, items: [{ id: 'k', name: { equals: 'Alpha' } }] },
    }),
    observed,
  );
  assert.equal(ratio(metricOf(closed, 'semanticPrecision')), '1/2=0.5', 'only decision_node nodes are in the closed scope; the concept node is not judged');
  assert.equal(ratio(metricOf(closed, 'capabilityPrecision')), '1/2=0.5');
  assert.deepEqual(closed.items.filter((i) => i.outcome === 'unexpected').map((i) => i.dimension).sort(), ['capability', 'fact']);
  assert.equal(metricOf(closed, 'workflowPrecision'), undefined, 'workflows were not declared closed');
});

test('workflow data flow has its own closed-world switch: extra PROVEN bindings fail only where the workflow declared it complete', () => {
  const extra = { ...binding, producerName: 'Gamma', producerCapabilityId: 'cG', output: 'g', input: 'g' };
  const observed = observation({ capabilities: [cap('cA', 'Alpha'), cap('cB', 'Beta')], workflows: [wf('w', [['cA', 'Alpha'], ['cB', 'Beta']], { bindings: [binding, extra] as never })] });
  const expected = (closedWorld: boolean) =>
    caseDef({ workflows: { items: [{ id: 'w1', steps: [{ equals: 'Alpha' }, { equals: 'Beta' }], dataFlow: { closedWorld, bindings: [{ producer: { equals: 'Alpha' }, output: 'y', consumer: { equals: 'Beta' }, input: 'x', status: 'proven' as const }] } }] } });
  assert.equal(ratio(metricOf(evaluateCase(expected(false), observed), 'dataFlowCorrectness')), '1/1=1');
  assert.equal(ratio(metricOf(evaluateCase(expected(true), observed), 'dataFlowCorrectness')), '1/2=0.5');
});

// ---- 4. the assumptions that are limitations, pinned so they cannot drift silently -------------

test('L2 (pinned): capabilityPrecision counts identity, semanticPrecision requires correctness — a located-but-wrong item is "precise" for one and not the other', () => {
  const ev = evaluateCase(
    caseDef({
      semantics: { facts: [ruleFact], closedWorldKinds: ['decision_node'] },
      capabilities: { closedWorld: true, items: [{ id: 'k', name: { equals: 'Alpha' }, executionClass: 'human_in_the_loop' }] },
    }),
    observation({ nodes: [ruleNode('n1', { outcome: 'approve the claim' })], capabilities: [cap('c1', 'Alpha')] }),
  );
  assert.equal(ratio(metricOf(ev, 'semanticPrecision')), '0/1=0', 'the located fact is incorrect => not precise');
  assert.equal(ratio(metricOf(ev, 'capabilityPrecision')), '1/1=1', 'the located capability has the wrong class but is still identity-matched => precise');
  assert.equal(ratio(metricOf(ev, 'executionClassAccuracy')), '0/1=0', 'its wrongness is measured here instead');
});

test('L3 (pinned): matching is greedy — two expectations that both match ONE observed capability are both counted as found', () => {
  const ev = evaluateCase(caseDef({ capabilities: { items: [{ id: 'k1', name: { contains: 'Claim' } }, { id: 'k2', name: { contains: 'Assessment' } }] } }), observation({ capabilities: [cap('c1', 'Claim Assessment')] }));
  assert.equal(ratio(metricOf(ev, 'capabilityRecall')), '2/2=1');
});

test('L5/L6 (pinned): avoidance counts one unit per forbidden spec but lists every hit; semanticCorrectness can fail with nothing listed (its cause is under semanticRecall)', () => {
  const trap = evaluateCase(caseDef({ capabilities: { forbidden: [{ id: 'nk', name: { contains: 'Schedule' } }] } }), observation({ capabilities: [cap('c1', 'Schedule Action'), cap('c2', 'Schedule Review')] }));
  const avoid = metricOf(trap, 'spuriousCapabilityAvoidance')!;
  assert.deepEqual([avoid.numerator, avoid.denominator, avoid.unexpected.length], [0, 1, 2]);

  const wrong = evaluateCase(caseDef({ semantics: { facts: [ruleFact] } }), observation({ nodes: [ruleNode('n1', { outcome: 'approve the claim' })] }));
  const correctness = metricOf(wrong, 'semanticCorrectness')!;
  assert.equal(correctness.denominator - correctness.numerator, 1);
  assert.deepEqual([correctness.missing.length, correctness.unexpected.length, correctness.mismatched.length], [0, 0, 0]);
  assert.equal(metricOf(wrong, 'semanticRecall')!.mismatched.length, 1);
});

test('spuriousCapabilityAvoidance measures avoidance of explicitly forbidden traps only: absent traps pass, present traps fail, unlisted extras are irrelevant', () => {
  const def = caseDef({ capabilities: { forbidden: [{ id: 't1', name: { equals: 'Trap One' } }, { id: 't2', name: { equals: 'Trap Two' } }, { id: 't3', name: { equals: 'Trap Three' } }] } });
  const ev = evaluateCase(def, observation({ capabilities: [cap('c1', 'Trap Two'), cap('c2', 'Something Else Entirely'), cap('c3', 'And Another')] }));
  const m = metricOf(ev, 'spuriousCapabilityAvoidance')!;
  assert.equal(ratio(m), '2/3=0.666667');
  assert.deepEqual(m.unexpected.map((i) => i.id), ['t2']);
  assert.deepEqual(ev.items.filter((i) => i.outcome === 'spurious').map((i) => i.id), ['t2']);
});

// ---- 5. micro-averaging -----------------------------------------------------------------------

test('aggregate = SUM(numerators) / SUM(denominators) (micro-average), not the mean of per-case ratios; unmeasured cases contribute nothing; absent cases do not dilute', () => {
  const declared = (id: string, n: number) => caseDef({ capabilities: { items: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}`, name: { equals: `${id}${i}` } })) } }, undefined, id);
  const small = evaluateCase(declared('s', 2), observation({ capabilities: [cap('s0', 's0')] })); // 1/2
  const large = evaluateCase(declared('l', 4), observation({ capabilities: [cap('l0', 'l0'), cap('l1', 'l1'), cap('l2', 'l2')] })); // 3/4
  const unmeasured = evaluateCase(caseDef({ capabilities: { closedWorld: true, items: [] } }, undefined, 'u'), observation({})); // capabilityPrecision 0/0
  const other = evaluateCase(caseDef({}, undefined, 'o'), observation({})); // declares no capability expectations at all

  const report = buildReport('s', [small, large, unmeasured, other]);
  const recall = report.aggregate.metrics.find((m) => m.id === 'capabilityRecall')!;
  assert.equal(ratio(recall), '4/6=0.666667', 'micro: (1+3)/(2+4)');
  assert.notEqual(recall.ratio, (0.5 + 0.75) / 2, 'not the macro mean');
  assert.equal(report.aggregate.metrics.find((m) => m.id === 'capabilityPrecision')!.ratio, null, 'only the 0/0 case emitted precision => still unmeasured');
  assert.deepEqual(recall.missing.map((i) => `${i.caseId}:${i.id}`), ['l:l3', 's:s1'], 'item lists are concatenated with their caseId');
});

test('a case with more expected items weighs more — and a metric absent from a case is neither a 0 nor a 1 in the aggregate', () => {
  const heavy = evaluateCase(caseDef({ capabilities: { items: Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, name: { equals: `h${i}` } })) } }, undefined, 'heavy'), observation({ capabilities: [] }));
  const light = evaluateCase(caseDef({ capabilities: { items: [{ id: 'l0', name: { equals: 'l0' } }] } }, undefined, 'light'), observation({ capabilities: [cap('l0', 'l0')] }));
  const recall = buildReport('s', [heavy, light]).aggregate.metrics.find((m) => m.id === 'capabilityRecall')!;
  assert.equal(ratio(recall), '1/10=0.1');
});

// ---- 6. warnings are not metrics; population changes are not regressions -----------------------

function reportOf(nodes: ReturnType<typeof ruleNode>[]): BenchmarkReport {
  const def = caseDef({ semantics: { facts: [ruleFact], closedWorldKinds: ['decision_node'] } });
  return buildReport('s', [evaluateCase(def, observation({ nodes }))]);
}

test('population change (intentional reduction of the evaluated population): surfaces as a coverage_reduced WARNING, never as a regression; the metric verdict is on items, not on the population size', () => {
  const noise = (id: string, q: string) => ruleNode(id, { question: q, outcome: 'x' });
  const before = reportOf([ruleNode('n1'), noise('t1', 'table row one'), noise('t2', 'table row two')]); // 1/3 precise
  const after = reportOf([ruleNode('n1')]); // the noise nodes are no longer produced: 1/1
  const cmp = compareReports(before, after);

  const precision = cmp.aggregate.find((d) => d.metricId === 'semanticPrecision')!;
  assert.equal(precision.verdict, 'improved');
  assert.equal(precision.coverageReduced, true, 'the denominator shrank 3 -> 1');
  assert.equal(precision.resolved.length, 2, 'two previously-unexpected items are gone');
  assert.deepEqual(cmp.warnings.filter((w) => w.kind === 'coverage_reduced').map((w) => w.metricId).sort(), ['observedSourceRefCoverage', 'semanticPrecision']);
  assert.equal(cmp.regressions.length, 0, 'a population change is not a regression');
  assert.equal(cmp.classification, 'improved');
});

test('warnings never decide the classification: a run whose only findings are warnings is no_change', () => {
  // Descriptive coverage: population 1 -> 3 nodes, all with source refs, in an OPEN-world scope. Nothing fails; the denominator grew.
  const openReport = (nodes: ReturnType<typeof ruleNode>[]) => buildReport('s', [evaluateCase(caseDef({ semantics: { facts: [ruleFact] } }), observation({ nodes }))]);
  const grown = compareReports(openReport([ruleNode('n1')]), openReport([ruleNode('n1'), ruleNode('n2', { question: 'a' }), ruleNode('n3', { question: 'b' })]));
  assert.equal(grown.classification, 'no_change');
  const refCoverage = grown.aggregate.find((d) => d.metricId === 'observedSourceRefCoverage')!;
  assert.equal(refCoverage.verdict, 'unchanged');
  assert.equal(refCoverage.coverageIncreased, true);
  assert.ok(!grown.warnings.some((w) => w.metricId === 'observedSourceRefCoverage'), 'L10: a denominator INCREASE produces no finding at all');

  // Removing a case is a real loss of measurement (regression); adding one is only a warning.
  const two = buildReport('s', [evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }, undefined, 'a'), observation({})), evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }, undefined, 'b'), observation({}))]);
  const one = buildReport('s', [evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }, undefined, 'a'), observation({}))]);
  assert.equal(compareReports(one, two).classification, 'no_change');
  assert.equal(compareReports(one, two).warnings.length, 1);
  assert.equal(compareReports(two, one).classification, 'regressed');
});

test('a metric that went unmeasured is a measurement LOSS (coverage_reduced), distinct from a metric that regressed', () => {
  const def = caseDef({ capabilities: { items: [{ id: 'k', name: { equals: 'A' }, executionClass: 'deterministic_rule' }] } });
  const before = buildReport('s', [evaluateCase(def, observation({ capabilities: [cap('a', 'A')] }))]);
  const after = buildReport('s', [evaluateCase(def, observation({ capabilities: [] }))]);
  const cmp = compareReports(before, after);
  assert.ok(cmp.regressions.some((f) => f.metricId === 'capabilityRecall'), 'the miss is a regression on the recall metric');
  assert.ok(cmp.warnings.some((w) => w.kind === 'coverage_reduced' && w.metricId === 'executionClassAccuracy'), 'the class assertion silently stopped being evaluated (L4)');
  assert.equal(cmp.aggregate.find((d) => d.metricId === 'executionClassAccuracy')!.after, null, 'not 0%: the metric is simply gone');
});

// ---- 7. unknown / not observable / not exercised ----------------------------------------------

test('stage observability: ok/failed are observations; skipped is not_observable; not_requested is not_exercised — none is a pass or a fail', () => {
  assert.equal(stageObservability('ok'), 'observed');
  assert.equal(stageObservability('failed'), 'observed');
  assert.equal(stageObservability('skipped'), 'not_observable');
  assert.equal(stageObservability('not_requested'), 'not_exercised');
});

test('L1 (pinned + flagged): compileOutcomeAccuracy still scores 1/1 on a skipped compile stage — the historical number is untouched — and interpretCase says it is vacuous', () => {
  const skipped = okStages({ compile: { stage: 'compile', status: 'skipped', note: 'serialized XOIR entry' } });
  const ev = evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({ stages: skipped }));
  assert.equal(ratio(metricOf(ev, 'compileOutcomeAccuracy')), '1/1=1', 'historical semantics preserved');
  const notes = interpretCase(ev);
  assert.deepEqual(notes.map((n) => [n.code, n.metricId]), [['compile_outcome_not_observable', 'compileOutcomeAccuracy']]);

  // A compile that really ran carries no such note.
  assert.deepEqual(interpretCase(evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({}))), []);
});

test('interpretCase flags unmeasured metrics, is deterministic, and never alters the evaluation it reads', () => {
  const ev = evaluateCase(everythingDef(), observation({}));
  const before = canonicalJson(ev);
  const notes = interpretCase(ev);
  assert.deepEqual(notes.filter((n) => n.code === 'metric_unmeasured').map((n) => n.metricId), ['capabilityPrecision', 'semanticCorrectness', 'semanticPrecision', 'workflowPrecision']);
  assert.equal(canonicalJson(interpretCase(ev)), canonicalJson(notes));
  assert.equal(canonicalJson(ev), before, 'the evaluation is untouched');
  assert.deepEqual(interpretCase({ ...ev, status: 'harness_error', metrics: [] } as CaseEvaluation), [], 'a harness error has no measurements to interpret');
});

test('not_exercised is not a failure: with no execution requested there is no execution metric at all, and AI is recorded as not exercised without a variant or a metric', () => {
  const ev = evaluateCase(caseDef({ compile: { outcome: 'succeeds' } }), observation({ stages: okStages({ execution: { stage: 'execution', status: 'not_requested' } }) }));
  assert.equal(metricOf(ev, 'executionCorrectness'), undefined);
  assert.equal(metricOf(ev, 'runtimeDataFlowTransfer'), undefined);
  assert.equal(ev.attribution!.configuration.ai, 'not_exercised');
  assert.ok(!METRIC_IDS.some((id) => id.toLowerCase().startsWith('ai')), 'no AI metric or variant exists: AI evaluation belongs to P1.5');
});

test('future dimensions are defined as semantics only (Steps 4-6 are now implemented; only contractBindingLinkage remains): none is a MetricId, none is emitted, and all say what is NOT measured', () => {
  assert.ok(RESERVED_DIMENSIONS.length >= 1);
  const ev = evaluateCase(everythingDef(), completeObservation());
  for (const reserved of RESERVED_DIMENSIONS) {
    assert.equal(reserved.implemented, false);
    assert.ok(!(reserved.id in METRIC_MODEL), `${reserved.id} is not a registered metric`);
    assert.ok(!ev.metrics.some((m) => m.id === (reserved.id as MetricId)), `${reserved.id} is not emitted`);
    assert.ok(reserved.denominator.length > 0 && reserved.correct.length > 0 && reserved.notMeasured.length > 0);
  }
  assert.deepEqual(new Set(RESERVED_DIMENSIONS.map((r) => r.ownerStep)), new Set(['P0.9C Step 5']));
  assert.deepEqual(DIMENSIONS.filter((d) => d.status === 'defined_not_implemented').map((d) => d.id), [], 'every defined dimension is now implemented; contractBindingLinkage stays a reserved metric semantics only');
  assert.deepEqual(DIMENSIONS.filter((d) => d.status === 'implemented_step_6').map((d) => d.id), ['cross_path_consistency']);
  assert.deepEqual(DIMENSIONS.filter((d) => d.status === 'implemented_step_4').map((d) => d.id), ['producer_attribution']);
});

// ---- 8. purity & determinism ------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

test('purity: evaluation, aggregation, comparison and interpretation do not mutate their inputs (deeply frozen inputs, identical results)', () => {
  const plainDef = everythingDef();
  const plainObs = completeObservation();
  const expected = evaluateCase(plainDef, plainObs);

  const frozenDef = deepFreeze(everythingDef());
  const frozenObs = deepFreeze(completeObservation());
  const ev = evaluateCase(frozenDef, frozenObs); // would throw a TypeError in strict mode if anything wrote to an input
  assert.equal(canonicalJson(ev), canonicalJson(expected));

  const report = deepFreeze(buildReport('s', [ev]));
  const cmp = compareReports(report, report);
  assert.equal(cmp.classification, 'no_change');
  interpretCase(deepFreeze(ev));
  assert.equal(canonicalJson(frozenObs), canonicalJson(plainObs), 'the observation is exactly what the pipeline produced');
});

test('deterministic and order-independent at the model level: two runs give byte-identical reports; shuffled expectation/observation lists give identical metrics, items and distributions', () => {
  const def = everythingDef();
  const reversedDef = caseDef(
    { ...EVERYTHING, capabilities: { ...EVERYTHING.capabilities!, items: [...EVERYTHING.capabilities!.items!].reverse() } },
    [...EVERYTHING_EXEC].reverse(),
  );
  const obs = completeObservation();
  const reversedObs = observation({ nodes: [...obs.nodes].reverse(), capabilities: [...obs.capabilities].reverse(), workflows: [...obs.workflows].reverse(), executions: [...obs.executions].reverse() });
  assert.equal(canonicalJson(buildReport('s', [evaluateCase(def, obs)])), canonicalJson(buildReport('s', [evaluateCase(def, obs)])));
  const pick = (e: CaseEvaluation) => canonicalJson({ metrics: e.metrics, items: e.items, observed: e.observed });
  assert.equal(pick(evaluateCase(reversedDef, reversedObs)), pick(evaluateCase(def, obs)));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase } from '../src/evaluate.js';
import type { BenchmarkCaseDefinition, CaseExpectations, ExecutionCase } from '../src/definition.js';
import { cap, capRun, caseDef, metricOf, node, observation, okStages, param, wf } from './helpers.js';

const ruleFact = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  kind: 'decision_node',
  identify: [{ path: 'question', contains: 'amount exceeds 10000' }],
  assert: [{ path: 'outcome', contains: 'deny' }],
  ...over,
});
const ruleNode = (id = 'n1', props: Record<string, unknown> = {}) => node(id, 'decision_node', { question: 'the claim amount exceeds 10000', outcome: 'deny the claim', ...props }, { pages: [1] });

function pct(m: { numerator: number; denominator: number; ratio: number | null } | undefined): string {
  return m === undefined ? 'absent' : `${m.numerator}/${m.denominator}=${m.ratio}`;
}

// ---------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------

test('exact expected semantic match: found, correct, complete — recall, correctness and (closed-world) precision are all 1 with nothing missing/unexpected', () => {
  const ev = evaluateCase(caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact()] } }), observation({ nodes: [ruleNode()] }));
  assert.equal(ev.status, 'evaluated');
  for (const id of ['semanticRecall', 'semanticCorrectness', 'semanticPrecision']) {
    const m = metricOf(ev, id)!;
    assert.equal(m.ratio, 1, id);
    assert.deepEqual([m.missing, m.unexpected, m.mismatched], [[], [], []]);
  }
  assert.deepEqual(ev.items.filter((i) => i.dimension === 'fact').map((i) => [i.id, i.outcome]), [['r1', 'found']]);
});

test('missing expected item: recall drops, the item is listed as missing with its attributed stage, and it is NOT counted in correctness (which is conditional on being located)', () => {
  const ev = evaluateCase(caseDef({ semantics: { facts: [ruleFact(), ruleFact({ id: 'r2', identify: [{ path: 'question', contains: 'flood' }] })] } }), observation({ nodes: [ruleNode()] }));
  const recall = metricOf(ev, 'semanticRecall')!;
  assert.equal(pct(recall), '1/2=0.5');
  assert.deepEqual(recall.missing.map((m) => [m.id, m.attributedStage]), [['r2', 'compile']]);
  assert.equal(pct(metricOf(ev, 'semanticCorrectness')), '1/1=1');
  assert.deepEqual(ev.items.filter((i) => i.id === 'r2').map((i) => i.outcome), ['missing']);
});

test('unexpected item: in a closed-world kind an unclaimed node lowers precision and is listed; in an open-world kind it is not judged (no precision metric — never a silent 100%)', () => {
  const nodes = [ruleNode('n1'), ruleNode('n2', { question: 'the loss is caused by an act of war', outcome: 'exclude' })];
  const closed = evaluateCase(caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact()] } }), observation({ nodes }));
  const precision = metricOf(closed, 'semanticPrecision')!;
  assert.equal(pct(precision), '1/2=0.5');
  assert.deepEqual(precision.unexpected.map((u) => u.id), ['decision_node|the loss is caused by an act of war']);
  assert.equal(pct(metricOf(closed, 'semanticRecall')), '1/1=1', 'recall is unaffected by extras');
  assert.ok(closed.items.some((i) => i.id === 'decision_node|the loss is caused by an act of war' && i.ref === 'n2' && i.outcome === 'unexpected'));

  const open = evaluateCase(caseDef({ semantics: { facts: [ruleFact()] } }), observation({ nodes }));
  assert.equal(metricOf(open, 'semanticPrecision'), undefined);
  assert.equal(open.items.some((i) => i.outcome === 'unexpected'), false);
});

test('semantic mismatch: identity located but an assertion fails => INCORRECT (not missing): recall counts it as not found, correctness 0/1, and the failing assertion is named', () => {
  const ev = evaluateCase(caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact({ assert: [{ path: 'outcome', contains: 'approve' }] })] } }), observation({ nodes: [ruleNode()] }));
  assert.equal(pct(metricOf(ev, 'semanticRecall')), '0/1=0');
  assert.equal(pct(metricOf(ev, 'semanticCorrectness')), '0/1=0');
  const recall = metricOf(ev, 'semanticRecall')!;
  assert.deepEqual([recall.missing.length, recall.mismatched.length], [0, 1]);
  assert.match(recall.mismatched[0]!.reason, /outcome contains "approve" does not hold/);
  const precision = metricOf(ev, 'semanticPrecision')!;
  assert.deepEqual([precision.numerator, precision.denominator, precision.mismatched.length, precision.unexpected.length], [0, 1, 1, 0], 'the located-but-wrong node is neither correct nor "unexpected"');
  assert.equal(ev.items.find((i) => i.id === 'r1')!.outcome, 'incorrect');
});

test('when several nodes satisfy an identity, the one that satisfies the assertions is chosen; each node is claimed by at most one fact', () => {
  const nodes = [ruleNode('a', { outcome: 'approve' }), ruleNode('b', { outcome: 'deny the claim' })];
  const ev = evaluateCase(caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact()] } }), observation({ nodes }));
  assert.equal(ev.items.find((i) => i.id === 'r1')!.ref, 'b');
  assert.equal(pct(metricOf(ev, 'semanticRecall')), '1/1=1');
  assert.deepEqual(metricOf(ev, 'semanticPrecision')!.unexpected.map((u) => u.id), ['decision_node|the claim amount exceeds 10000']);
});

test('forbidden facts: a present forbidden node is spurious and fails spuriousFactAvoidance; absence passes', () => {
  const forbidden = [
    { id: 'no-pronoun', kind: 'concept', identify: [{ path: 'definition', equals: 'It' }], reason: 'pronoun' },
    { id: 'no-flood', kind: 'concept', identify: [{ path: 'definition', equals: 'Flood' }] },
  ];
  const ev = evaluateCase(caseDef({ semantics: { forbidden } }), observation({ nodes: [node('c1', 'concept', { definition: 'It' })] }));
  const m = metricOf(ev, 'spuriousFactAvoidance')!;
  assert.equal(pct(m), '1/2=0.5');
  assert.deepEqual(m.unexpected.map((u) => u.id), ['no-pronoun']);
  assert.ok(ev.items.some((i) => i.id === 'no-pronoun' && i.outcome === 'spurious'));
});

test('predicate normalization: matching is case- and whitespace-insensitive, but never fuzzy', () => {
  const ev = evaluateCase(caseDef({ semantics: { facts: [ruleFact({ identify: [{ path: 'question', equals: 'THE claim   amount EXCEEDS 10000' }] }), ruleFact({ id: 'r-fuzzy', identify: [{ path: 'question', equals: 'claim amount exceeds 10000' }] })] } }), observation({ nodes: [ruleNode()] }));
  assert.deepEqual(ev.items.filter((i) => i.dimension === 'fact').map((i) => [i.id, i.outcome]), [['r-fuzzy', 'missing'], ['r1', 'found']]);
});

// ---------------------------------------------------------------------------
// Capabilities: discovery, resolution, execution class, structured I/O
// ---------------------------------------------------------------------------

const capExp = (over: Record<string, unknown> = {}) => ({ id: 'k1', name: { equals: 'Claim Assessment' }, ...over });

test('exact capability match: recall, resolution, class and I/O all 1', () => {
  const observed = cap('cap1', 'Claim Assessment', { inputs: [param('claim amount')], outputs: [param('matched')] });
  const ev = evaluateCase(caseDef({ capabilities: { closedWorld: true, items: [capExp({ resolution: 'resolved', executionClass: 'deterministic_rule', inputs: ['claim_amount'], outputs: ['matched'] })] } }), observation({ capabilities: [observed] }));
  for (const id of ['capabilityRecall', 'capabilityPrecision', 'resolutionAccuracy', 'executionClassAccuracy']) assert.equal(metricOf(ev, id)!.ratio, 1, id);
  assert.equal(pct(metricOf(ev, 'structuredIoAccuracy')), '2/2=1');
  assert.equal(ev.items.find((i) => i.id === 'k1')!.outcome, 'found');
});

test('execution-class mismatch: the capability is DISCOVERED (recall 1) but the class is wrong — accuracy drops, the mismatch is attributed to `capabilities`, and a confusion breakdown is kept', () => {
  const ev = evaluateCase(caseDef({ capabilities: { items: [capExp({ executionClass: 'human_in_the_loop' }), capExp({ id: 'k2', name: { equals: 'Second' }, executionClass: 'deterministic_rule' })] } }), observation({ capabilities: [cap('c1', 'Claim Assessment'), cap('c2', 'Second')] }));
  assert.equal(metricOf(ev, 'capabilityRecall')!.ratio, 1);
  const klass = metricOf(ev, 'executionClassAccuracy')!;
  assert.equal(pct(klass), '1/2=0.5');
  assert.deepEqual(klass.mismatched.map((m) => [m.id, m.attributedStage]), [['k1', 'capabilities']]);
  assert.deepEqual(klass.breakdown, { 'deterministic_rule->deterministic_rule': 1, 'human_in_the_loop->deterministic_rule': 1 });
  assert.equal(ev.items.find((i) => i.id === 'k1')!.outcome, 'incorrect');
});

test('unresolved / ambiguous / denied are distinct from each other and from `not_executable` as a class', () => {
  const observed = [
    cap('u', 'Unresolved one', { resolution: 'unresolved', executionClass: 'not_executable', notExecutableReason: 'no rule evidence' }),
    cap('a', 'Ambiguous one', { resolution: 'ambiguous', executionClass: 'not_executable' }),
    cap('d', 'Denied one', { resolution: 'denied', executionClass: 'not_executable' }),
  ];
  const items = [
    { id: 'e-u', name: { equals: 'Unresolved one' }, resolution: 'unresolved', executionClass: 'not_executable' },
    { id: 'e-a', name: { equals: 'Ambiguous one' }, resolution: 'unresolved', executionClass: 'not_executable' }, // wrong on purpose: it is ambiguous
    { id: 'e-d', name: { equals: 'Denied one' }, resolution: 'denied', executionClass: 'not_executable' },
  ] as never;
  const ev = evaluateCase(caseDef({ capabilities: { items } }), observation({ capabilities: observed }));
  const res = metricOf(ev, 'resolutionAccuracy')!;
  assert.equal(pct(res), '2/3=0.666667');
  assert.match(res.mismatched[0]!.reason, /expected resolution "unresolved", got "ambiguous"/);
  assert.equal(metricOf(ev, 'executionClassAccuracy')!.ratio, 1, 'all three are correctly "not executable"');
  assert.deepEqual(ev.observed.capabilities.byResolution, { ambiguous: 1, denied: 1, unresolved: 1 });
});

test('missing / unexpected capabilities: closed-world precision counts discovered-but-unexpected ones; forbidden names fail avoidance; recall lists what is absent', () => {
  const ev = evaluateCase(
    caseDef({ capabilities: { closedWorld: true, items: [capExp(), capExp({ id: 'k2', name: { equals: 'Absent capability' } })], forbidden: [{ id: 'no-generic', name: { equals: 'Schedule Action' } }] } }),
    observation({ capabilities: [cap('c1', 'Claim Assessment'), cap('c2', 'Schedule Action', { resolution: 'unresolved', executionClass: 'not_executable' })] }),
  );
  assert.equal(pct(metricOf(ev, 'capabilityRecall')), '1/2=0.5');
  assert.deepEqual(metricOf(ev, 'capabilityRecall')!.missing.map((m) => m.id), ['k2']);
  assert.equal(pct(metricOf(ev, 'capabilityPrecision')), '1/2=0.5');
  assert.deepEqual(metricOf(ev, 'capabilityPrecision')!.unexpected.map((m) => m.id), ['capability|schedule action']);
  assert.equal(pct(metricOf(ev, 'spuriousCapabilityAvoidance')), '0/1=0');
});

test('structured I/O: a missing and an unexpected parameter are reported separately; matching accepts a parameter name or its runtime key', () => {
  const observed = cap('c1', 'Claim Assessment', { inputs: [param('claim amount'), param('extra field')], outputs: [] });
  const ev = evaluateCase(caseDef({ capabilities: { items: [capExp({ inputs: ['claim_amount', 'rate'], outputs: [] })] } }), observation({ capabilities: [observed] }));
  const io = metricOf(ev, 'structuredIoAccuracy')!;
  assert.equal(pct(io), '1/2=0.5');
  assert.equal(io.missing.length, 1);
  assert.equal(io.unexpected.length, 1);
  assert.match(io.missing[0]!.reason, /missing \[rate\]/);
  assert.match(io.unexpected[0]!.reason, /unexpected \[extra field\]/);
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

test('provenance mismatch: expected document/pages/minimum refs are checked against the located item; only located items with an evidence spec are counted', () => {
  const nodes = [ruleNode('n1'), node('n2', 'decision_node', { question: 'the loss type is flood', outcome: 'deny' }, { pages: [2], doc: 'docs/other.pdf' }), node('n3', 'decision_node', { question: 'the loss type is theft', outcome: 'refer' }, { refs: 0 })];
  const fact = (id: string, q: string, evidence: object) => ({ id, kind: 'decision_node', identify: [{ path: 'question', contains: q }], evidence });
  const ev = evaluateCase(
    caseDef({ semantics: { facts: [fact('e-ok', 'amount exceeds', { documentPath: 'policy.pdf', pages: [1] }), fact('e-doc', 'flood', { documentPath: 'policy.pdf' }), fact('e-page', 'flood', { pages: [7] }), fact('e-none', 'theft', { minSourceRefs: 1 }), fact('e-absent', 'nothing-like-this', { minSourceRefs: 1 })] } }),
    observation({ nodes }),
  );
  const prov = metricOf(ev, 'provenanceCompleteness')!;
  assert.equal(pct(prov), '1/4=0.25', 'the located-nowhere fact is not a provenance failure (it is a recall miss)');
  assert.deepEqual(prov.mismatched.map((m) => m.id), ['e-doc', 'e-none', 'e-page']);
  assert.match(prov.mismatched.find((m) => m.id === 'e-doc')!.reason, /no source ref from a document ending in "policy.pdf"/);
  assert.match(prov.mismatched.find((m) => m.id === 'e-page')!.reason, /page\(s\) 7 not cited/);
  assert.match(prov.mismatched.find((m) => m.id === 'e-none')!.reason, /has 0 source ref\(s\)/);
});

test('observedSourceRefCoverage is descriptive: it counts nodes without provenance regardless of any expectation', () => {
  const ev = evaluateCase(caseDef({}), observation({ nodes: [node('a', 'concept', {}), node('b', 'concept', {}, { refs: 0 })] }));
  const cov = metricOf(ev, 'observedSourceRefCoverage')!;
  assert.equal(pct(cov), '1/2=0.5');
  assert.equal(cov.missing.length, 1);
});

// ---------------------------------------------------------------------------
// Workflows and data flow
// ---------------------------------------------------------------------------

const binding = (over: Record<string, unknown> = {}) => ({ producerCapabilityId: 'cA', producerName: 'Check threshold', output: 'matched', consumerCapabilityId: 'cB', consumerName: 'Authorize payout', input: 'matched', status: 'proven', wired: true, ...over });
const wfExp = (over: Record<string, unknown> = {}) => ({ id: 'w1', steps: [{ equals: 'Check threshold' }, { equals: 'Authorize payout' }], ...over });
const flowWf = (over: Record<string, unknown> = {}) => wf('wf_1', [['cA', 'Check threshold'], ['cB', 'Authorize payout']], { bindings: [binding()] as never, ...over });
const caps2 = [cap('cA', 'Check threshold'), cap('cB', 'Authorize payout')];

test('exact workflow match: recall/precision/executability/structure/data-flow all 1; step SET matching is independent of the order the expectation lists the steps', () => {
  const expectations: CaseExpectations = { workflows: { closedWorld: true, items: [wfExp({ steps: [{ equals: 'Authorize payout' }, { equals: 'Check threshold' }], executability: 'executable_candidate', dataFlow: { closedWorld: true, bindings: [{ producer: { equals: 'Check threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched', status: 'proven' }] } })] } };
  const ev = evaluateCase(caseDef(expectations), observation({ capabilities: caps2, workflows: [flowWf()] }));
  for (const id of ['workflowRecall', 'workflowPrecision', 'workflowExecutabilityAccuracy', 'dataFlowCorrectness']) assert.equal(metricOf(ev, id)!.ratio, 1, id);
});

test('workflow mismatch: a missing workflow (upstream capability absent => attributed to `capabilities`), wrong executability, wrong order, wrong step classes, unexpected extra workflow', () => {
  const observed = [
    wf('wf_1', [['cA', 'Check threshold'], ['cB', 'Authorize payout']], { executability: 'not_executable_yet', blockerKinds: ['ambiguous_precedence'] }),
    wf('wf_x', [['cX', 'Stray step']]),
  ];
  const expectations: CaseExpectations = {
    workflows: {
      closedWorld: true,
      items: [
        wfExp({ executability: 'executable_candidate', ordered: true, stepClasses: ['human_in_the_loop', 'deterministic_rule'], steps: [{ equals: 'Authorize payout' }, { equals: 'Check threshold' }] }),
        wfExp({ id: 'w2', steps: [{ equals: 'Check threshold' }, { equals: 'A capability that was never discovered' }] }),
      ],
    },
  };
  const ev = evaluateCase(caseDef(expectations), observation({ capabilities: caps2, workflows: observed }));
  const recall = metricOf(ev, 'workflowRecall')!;
  assert.equal(pct(recall), '1/2=0.5');
  assert.deepEqual(recall.missing.map((m) => [m.id, m.attributedStage]), [['w2', 'capabilities']]);
  assert.match(metricOf(ev, 'workflowExecutabilityAccuracy')!.mismatched[0]!.reason, /expected executability "executable_candidate", got "not_executable_yet" \(blockers: ambiguous_precedence\)/);
  const structure = metricOf(ev, 'workflowStructureAccuracy')!;
  assert.equal(pct(structure), '0/2=0');
  assert.deepEqual(structure.mismatched.map((m) => m.id).sort(), ['w1.order', 'w1.stepClasses']);
  assert.equal(pct(metricOf(ev, 'workflowPrecision')), '1/2=0.5');
  assert.deepEqual(metricOf(ev, 'workflowPrecision')!.unexpected.map((m) => m.id), ['workflow|stray step']);
});

test('data-flow: a missing proven binding, a "suggestive" one reported as not proven, a violated not_proven assertion, and an extra proven binding in a closed-world workflow are each distinct failures', () => {
  const bindings = [binding(), binding({ producerName: 'Other', producerCapabilityId: 'cO', status: 'suggestive', wired: false, output: 'x', input: 'x' }), binding({ producerName: 'Extra', producerCapabilityId: 'cE', output: 'e', input: 'e' })];
  const flow = flowWf({ bindings: bindings as never });
  const df = (b: object[], closedWorld = false) => evaluateCase(caseDef({ workflows: { items: [wfExp({ dataFlow: { closedWorld, bindings: b } })] } }), observation({ capabilities: caps2, workflows: [flow] }));

  const missing = df([{ producer: { equals: 'Other' }, output: 'x', consumer: { equals: 'Authorize payout' }, input: 'x', status: 'proven' }]);
  const m1 = metricOf(missing, 'dataFlowCorrectness')!;
  assert.equal(pct(m1), '0/1=0');
  assert.match(m1.missing[0]!.reason, /audit reports it as "suggestive"/);

  const violated = df([{ producer: { equals: 'Check threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched', status: 'not_proven' }]);
  assert.match(metricOf(violated, 'dataFlowCorrectness')!.unexpected[0]!.reason, /must NOT be proven/);

  const closed = df([{ producer: { equals: 'Check threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched', status: 'proven' }], true);
  const m3 = metricOf(closed, 'dataFlowCorrectness')!;
  assert.equal(pct(m3), '1/2=0.5', 'the expected binding passes; the extra proven one is an unexpected assertion failure');
  assert.match(m3.unexpected[0]!.reason, /extra PROVEN binding Extra\.e -> Authorize payout\.e/);
});

test('data-flow assertions are not evaluated for a workflow that was not found (that is a workflowRecall miss) — and the comparator will flag the lost coverage', () => {
  const ev = evaluateCase(caseDef({ workflows: { items: [wfExp({ dataFlow: { bindings: [{ producer: { equals: 'Check threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched', status: 'proven' }] } })] } }), observation({ capabilities: caps2, workflows: [] }));
  assert.equal(metricOf(ev, 'dataFlowCorrectness'), undefined);
  assert.equal(metricOf(ev, 'workflowRecall')!.ratio, 0);
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const runCap = (over: Partial<Extract<ExecutionCase, { kind: 'capability' }>> & { expect: Extract<ExecutionCase, { kind: 'capability' }>['expect'] }): ExecutionCase => ({ id: 'x1', kind: 'capability', target: { equals: 'Claim Assessment' }, ...over }) as ExecutionCase;

test('execution: outcome, output subset and error code are each checked; failures are attributed to the stage where the divergence originates', () => {
  const cases: ExecutionCase[] = [
    runCap({ id: 'ok', expect: { outcome: 'succeeded', output: { matched: true } } }),
    runCap({ id: 'wrong-output', expect: { outcome: 'succeeded', output: { matched: true } } }),
    runCap({ id: 'runtime-error', expect: { outcome: 'succeeded' } }),
    runCap({ id: 'unresolved-upstream', expect: { outcome: 'succeeded' } }),
    runCap({ id: 'not-found', target: { equals: 'Nope' }, expect: { outcome: 'succeeded' } }),
  ];
  const executions = [
    capRun('ok', { output: { matched: true, extra: 1 } }),
    capRun('wrong-output', { output: { matched: false } }),
    capRun('runtime-error', { outcome: 'error', errorCode: 'XO_X', message: 'boom' }),
    capRun('unresolved-upstream', { outcome: 'not_executable', message: 'unresolved: no rule' }),
    capRun('not-found', { outcome: 'target_not_found' }),
  ];
  const ev = evaluateCase(caseDef({}, cases), observation({ capabilities: [cap('c1', 'Claim Assessment')], executions }));
  const m = metricOf(ev, 'executionCorrectness')!;
  assert.equal(pct(m), '1/5=0.2');
  const stageOf = (id: string) => m.mismatched.find((x) => x.id === id)!.attributedStage;
  assert.equal(stageOf('wrong-output'), 'execution');
  assert.equal(stageOf('runtime-error'), 'execution');
  assert.equal(stageOf('unresolved-upstream'), 'capabilities', 'the runtime cannot run what compilation left unresolved');
  assert.equal(stageOf('not-found'), 'capabilities');
  assert.deepEqual(ev.items.filter((i) => i.dimension === 'execution').map((i) => [i.id, i.outcome]), [['not-found', 'failed'], ['ok', 'passed'], ['runtime-error', 'failed'], ['unresolved-upstream', 'failed'], ['wrong-output', 'failed']]);
});

test('execution "not_executable" expectations pass only when the runtime honestly refused; executing something that should be refused is a failure attributed to `capabilities`', () => {
  const cases = [runCap({ id: 'refuse', expect: { outcome: 'not_executable' } }), runCap({ id: 'should-refuse', expect: { outcome: 'not_executable' } })];
  const ev = evaluateCase(caseDef({}, cases), observation({ executions: [capRun('refuse', { outcome: 'not_executable' }), capRun('should-refuse', { outcome: 'succeeded', output: { matched: true } })] }));
  const m = metricOf(ev, 'executionCorrectness')!;
  assert.equal(pct(m), '1/2=0.5');
  assert.equal(m.mismatched[0]!.attributedStage, 'capabilities');
});

test('workflow execution: run status, step output status, runtime data-flow transfer (the consumer actually RECEIVED the producer value) and refusal are evaluated separately', () => {
  const wfCase = (id: string, over: object = {}): ExecutionCase => ({ id, kind: 'workflow', steps: [{ equals: 'Check threshold' }, { equals: 'Authorize payout' }], expect: { status: 'completed', injections: [{ producer: { equals: 'Check threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched' }] }, ...over }) as ExecutionCase;
  const ran = (requestId: string, consumerInput: Record<string, unknown>, over: object = {}) => ({
    requestId,
    kind: 'workflow' as const,
    outcome: 'ran' as const,
    runStatus: 'completed' as const,
    steps: [
      { capabilityId: 'cA', name: 'Check threshold', engineStepStatus: 'completed', output: { matched: true }, actualInput: {} },
      { capabilityId: 'cB', name: 'Authorize payout', engineStepStatus: 'completed', output: { matched: true }, actualInput: consumerInput },
    ],
    ...over,
  });
  const executions = [
    ran('transferred', { matched: true }),
    ran('not-transferred', {}),
    ran('wrong-value', { matched: false }),
    { requestId: 'refused', kind: 'workflow' as const, outcome: 'refused' as const, runStatus: 'not_executable_yet' as const, workflowExecutability: 'not_executable_yet' as const, steps: [], message: 'audit says no' },
  ];
  const cases = [wfCase('transferred'), wfCase('not-transferred'), wfCase('wrong-value'), wfCase('refused', { expect: { status: 'not_executable_yet' } })];
  const ev = evaluateCase(caseDef({}, cases), observation({ capabilities: caps2, executions }));
  assert.equal(pct(metricOf(ev, 'executionCorrectness')), '2/4=0.5');
  const transfer = metricOf(ev, 'runtimeDataFlowTransfer')!;
  assert.equal(pct(transfer), '1/3=0.333333');
  assert.ok(transfer.missing.some((m) => m.id === 'not-transferred' && /consumer actually received undefined/.test(m.reason)));
  assert.ok(transfer.missing.some((m) => m.id === 'wrong-value' && /consumer actually received false/.test(m.reason)));
});

// ---------------------------------------------------------------------------
// Stage failures, harness errors, emptiness
// ---------------------------------------------------------------------------

test('a failed compile stage: everything expected is missing and attributed to `compile` with the compiler error; downstream stages are reported skipped', () => {
  const stages = okStages({
    compile: { stage: 'compile', status: 'failed', errorCode: 'XO_PRECONDITION_FAILED', errorMessage: 'no extractable content' },
    capabilities: { stage: 'capabilities', status: 'skipped', note: 'skipped: the "compile" stage failed' },
    workflows: { stage: 'workflows', status: 'skipped' },
  });
  const ev = evaluateCase(
    caseDef({ compile: { outcome: 'succeeds' }, semantics: { facts: [ruleFact()] }, capabilities: { items: [capExp()] } }, [runCap({ id: 'x', expect: { outcome: 'succeeded' } })]),
    observation({ stages }),
  );
  assert.equal(metricOf(ev, 'compileOutcomeAccuracy')!.ratio, 0);
  assert.match(metricOf(ev, 'compileOutcomeAccuracy')!.mismatched[0]!.reason, /it failed: \[XO_PRECONDITION_FAILED\]/);
  assert.match(metricOf(ev, 'semanticRecall')!.missing[0]!.reason, /compile stage failed/);
  assert.equal(metricOf(ev, 'capabilityRecall')!.missing[0]!.attributedStage, 'compile');
  const exec = metricOf(ev, 'executionCorrectness')!;
  assert.equal(exec.mismatched.length + exec.missing.length, 1);
  assert.equal(exec.missing[0]!.attributedStage, 'compile');
  assert.equal(ev.items.find((i) => i.id === 'x')!.outcome, 'not_run');
});

test('an EXPECTED compile failure counts as correct (`fails` + matching error code)', () => {
  const stages = okStages({ compile: { stage: 'compile', status: 'failed', errorCode: 'XO_PRECONDITION_FAILED', errorMessage: 'x' } });
  const pass = evaluateCase(caseDef({ compile: { outcome: 'fails', errorCode: 'XO_PRECONDITION_FAILED' } }), observation({ stages }));
  const wrongCode = evaluateCase(caseDef({ compile: { outcome: 'fails', errorCode: 'XO_OTHER' } }), observation({ stages }));
  assert.equal(metricOf(pass, 'compileOutcomeAccuracy')!.ratio, 1);
  assert.equal(metricOf(wrongCode, 'compileOutcomeAccuracy')!.ratio, 0);
});

test('a harness error is reported as such and produces NO metrics (it is neither an XO pass nor an XO failure)', () => {
  const ev = evaluateCase(caseDef({ semantics: { facts: [ruleFact()] } }), observation({ harnessError: 'could not read source fixture: ENOENT' }));
  assert.equal(ev.status, 'harness_error');
  assert.equal(ev.harnessError, 'could not read source fixture: ENOENT');
  assert.deepEqual(ev.metrics, []);
  assert.deepEqual(ev.items, []);
});

test('nothing to measure => ratio null, measured false — never 1, never 0', () => {
  const ev = evaluateCase(caseDef({ semantics: { facts: [], closedWorldKinds: ['decision_node'] } }), observation({ nodes: [] }));
  const precision = metricOf(ev, 'semanticPrecision')!;
  assert.deepEqual([precision.numerator, precision.denominator, precision.ratio, precision.measured], [0, 0, null, false]);
  assert.equal(metricOf(ev, 'semanticRecall'), undefined, 'no expected facts => the recall metric is not even emitted');
});

// ---------------------------------------------------------------------------
// Order independence & determinism
// ---------------------------------------------------------------------------

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test('order independence: shuffling the definition lists and the observation lists never changes a single number or item', () => {
  const definition: BenchmarkCaseDefinition = caseDef(
    {
      compile: { outcome: 'succeeds' },
      semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact(), ruleFact({ id: 'r2', identify: [{ path: 'question', contains: 'theft' }], assert: [{ path: 'outcome', contains: 'zzz' }] }), ruleFact({ id: 'r3', identify: [{ path: 'question', contains: 'absent' }] })], forbidden: [{ id: 'f1', kind: 'concept', identify: [{ path: 'definition', equals: 'It' }] }] },
      capabilities: { closedWorld: true, items: [capExp(), capExp({ id: 'k2', name: { equals: 'Second' }, executionClass: 'human_in_the_loop' })], forbidden: [{ id: 'nf', name: { equals: 'Junk' } }] },
      workflows: { closedWorld: true, items: [wfExp({ executability: 'executable_candidate' }), wfExp({ id: 'w2', steps: [{ equals: 'Second' }] })] },
    },
    [runCap({ id: 'e1', expect: { outcome: 'succeeded' } }), runCap({ id: 'e2', expect: { outcome: 'not_executable' } })],
  );
  const obs = observation({
    nodes: [ruleNode('n1'), ruleNode('n2', { question: 'the loss type is theft', outcome: 'refer' }), ruleNode('n3', { question: 'stray', outcome: 'x' }), node('c1', 'concept', { definition: 'It' })],
    capabilities: [cap('c1', 'Claim Assessment'), cap('c2', 'Second'), cap('c3', 'Junk')],
    workflows: [flowWf(), wf('wf_2', [['c2', 'Second']])],
    executions: [capRun('e1', { output: { matched: true } }), capRun('e2', { outcome: 'succeeded' })],
  });
  const baseline = JSON.stringify(evaluateCase(definition, obs));
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const d = definition;
    const permutedDef: BenchmarkCaseDefinition = {
      ...d,
      expect: {
        ...d.expect,
        semantics: { ...d.expect.semantics!, facts: shuffled(d.expect.semantics!.facts!, seed) },
        capabilities: { ...d.expect.capabilities!, items: shuffled(d.expect.capabilities!.items!, seed) },
        workflows: { ...d.expect.workflows!, items: shuffled(d.expect.workflows!.items!, seed) },
      },
      execution: shuffled(d.execution!, seed),
    };
    const permutedObs = { ...obs, nodes: shuffled(obs.nodes, seed), capabilities: shuffled(obs.capabilities, seed), workflows: shuffled(obs.workflows, seed), executions: shuffled(obs.executions, seed) };
    assert.equal(JSON.stringify(evaluateCase(permutedDef, permutedObs)), baseline, `seed ${seed}`);
  }
});

test('determinism: evaluating the same definition/observation twice yields byte-identical results', () => {
  const definition = caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [ruleFact()] } });
  const obs = observation({ nodes: [ruleNode()] });
  assert.equal(JSON.stringify(evaluateCase(definition, obs)), JSON.stringify(evaluateCase(definition, obs)));
});

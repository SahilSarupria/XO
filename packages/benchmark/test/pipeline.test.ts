import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeCase, runSuite, validateSuiteDefinition, type BenchmarkReport, type BenchmarkSuiteDefinition, type CaseEvaluation, type MetricResult } from '../src/index.js';

/**
 * These tests drive the REAL pipeline (`compileSources` -> XOIR ->
 * `packageXoirGraph` lowering / contracts -> workflow composer + audit ->
 * runtime bridge + executor) through `observeCase`/`runSuite`, and
 * assert how the evaluation layer classifies the real output. The only
 * thing varied is what the DEFINITION expects.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SYNTHETIC = 'examples/vertical-test/synthetic-claim-rules.txt';
const MECHANICS_XOIR = 'packages/benchmark/fixtures/xoir/runtime-mechanics.xoir.json';

function suiteOf(cases: unknown[], id = 'inline'): BenchmarkSuiteDefinition {
  const r = validateSuiteDefinition({ schemaVersion: 1, suiteId: id, cases });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const metric = (c: CaseEvaluation, id: string): MetricResult | undefined => c.metrics.find((m) => m.id === id);
const only = (report: BenchmarkReport): CaseEvaluation => report.cases[0]!;

test('REAL pipeline, exact expectations: the synthetic claim-rules document is evaluated at 100% on every measured dimension', async () => {
  const report = await runSuite(
    suiteOf([
      {
        caseId: 'synthetic',
        sources: [{ kind: 'document', path: SYNTHETIC }],
        expect: {
          compile: { outcome: 'succeeds' },
          semantics: { closedWorldKinds: ['decision_node'], facts: [{ id: 'rule', kind: 'decision_node', identify: [{ path: 'question', contains: 'claim assessment amount exceeds 10000' }], assert: [{ path: 'outcome', contains: 'deny the claim' }, { path: 'structuredCondition.operator', equals: '>' }, { path: 'structuredCondition.value', equals: 10000 }], evidence: { documentPath: 'synthetic-claim-rules.txt', pages: [1] } }] },
          capabilities: { closedWorld: true, items: [{ id: 'assess', name: { equals: 'Claim Assessment' }, resolution: 'resolved', executionClass: 'deterministic_rule', inputs: ['claim_assessment_amount'] }, { id: 'deny', name: { equals: 'Deny The Claim' }, resolution: 'resolved', executionClass: 'deterministic_rule' }] },
          workflows: { closedWorld: true, items: [{ id: 'wf', steps: [{ equals: 'Claim Assessment' }, { equals: 'Deny The Claim' }], executability: 'not_executable_yet' }] },
        },
        execution: [{ id: 'over', kind: 'capability', target: { equals: 'Claim Assessment' }, input: { claim_assessment_amount: 15000 }, expect: { outcome: 'succeeded', output: { matched: true, outcome: 'deny the claim' } } }],
      },
    ]),
    { sourceRoot: REPO_ROOT },
  );
  const c = only(report);
  assert.deepEqual(Object.values(c.stages).map((s) => s.status), ['ok', 'ok', 'ok', 'ok']);
  for (const m of c.metrics) assert.equal(m.ratio, 1, `${m.id}: ${m.numerator}/${m.denominator} ${JSON.stringify([...m.missing, ...m.unexpected, ...m.mismatched])}`);
  assert.equal(report.measured, true);
  assert.equal(c.observed.capabilities.byExecutionClass['deterministic_rule'], 2);
});

test('REAL pipeline, wrong expectations: each kind of failure is reported as ITS OWN kind (missing / incorrect / spurious / unexpected / class mismatch / workflow mismatch / provenance mismatch / execution mismatch)', async () => {
  const report = await runSuite(
    suiteOf([
      {
        caseId: 'synthetic-wrong',
        sources: [{ kind: 'document', path: SYNTHETIC }],
        expect: {
          semantics: {
            closedWorldKinds: ['concept'],
            facts: [
              { id: 'located-and-right', kind: 'concept', identify: [{ path: 'definition', equals: 'XO' }] },
              { id: 'located-but-wrong', kind: 'decision_node', identify: [{ path: 'question', contains: 'exceeds 10000' }], assert: [{ path: 'structuredCondition.operator', equals: '<' }] },
              { id: 'absent', kind: 'decision_node', identify: [{ path: 'question', contains: 'flood' }] },
              { id: 'wrong-page', kind: 'concept', identify: [{ path: 'definition', equals: 'Claim Assessment' }], evidence: { pages: [9] } },
            ],
            forbidden: [{ id: 'no-pronoun-concept', kind: 'concept', identify: [{ path: 'definition', equals: 'It' }] }],
          },
          capabilities: { items: [{ id: 'wrong-class', name: { equals: 'Claim Assessment' }, executionClass: 'human_in_the_loop' }, { id: 'wrong-resolution', name: { equals: 'Deny The Claim' }, resolution: 'unresolved' }] },
          workflows: { items: [{ id: 'wf-wrong-status', steps: [{ equals: 'Claim Assessment' }, { equals: 'Deny The Claim' }], executability: 'executable_candidate' }, { id: 'wf-absent', steps: [{ equals: 'Claim Assessment' }, { equals: 'A step that does not exist' }] }] },
        },
        execution: [{ id: 'wrong-outcome', kind: 'capability', target: { equals: 'Claim Assessment' }, input: { claim_assessment_amount: 15000 }, expect: { outcome: 'waiting_for_human' } }],
      },
    ]),
    { sourceRoot: REPO_ROOT },
  );
  const c = only(report);
  const outcomes = Object.fromEntries(c.items.filter((i) => ['fact', 'capability', 'workflow', 'execution'].includes(i.dimension) && i.outcome !== 'unexpected').map((i) => [i.id, i.outcome]));
  // `no-pronoun-concept` (forbidden: a bare "It" concept) is intentionally
  // absent from `outcomes` below, not `'spurious'`: as of Layer 3 (P0.9
  // Beta, see packages/benchmark/CHANGELOG.md and
  // capitalized-run-detector.test.ts), sentence-initial function words
  // ("It", "This", "If", ...) are no longer minted as spurious concept
  // nodes in the first place, so the forbidden-fact check in
  // evaluate.ts genuinely finds nothing to flag and emits no item at
  // all for it (see the `for (const f of forbidden)` loop in
  // evaluate.ts, which only pushes an item on a hit) — this is the
  // fixed behavior this suite exists to characterize, not a gap in the
  // test.
  assert.deepEqual(outcomes, {
    'located-and-right': 'found',
    'located-but-wrong': 'incorrect',
    absent: 'missing',
    'wrong-page': 'found',
    'wrong-class': 'incorrect',
    'wrong-resolution': 'incorrect',
    'wf-wrong-status': 'incorrect',
    'wf-absent': 'missing',
    'wrong-outcome': 'failed',
  });

  const ratio = (id: string): string => `${metric(c, id)!.numerator}/${metric(c, id)!.denominator}`;
  assert.equal(ratio('semanticRecall'), '2/4');
  assert.equal(ratio('semanticCorrectness'), '2/3');
  // `semanticPrecision` denominator drops from 5 to 2 (2 correct, 0
  // unexpected) for the same reason as above: the three pronoun-shaped
  // concept nodes ("It", "This", "If") that used to be spuriously
  // extracted from this fixture's own prose no longer exist post-Layer-3.
  assert.equal(ratio('semanticPrecision'), '2/2');
  assert.deepEqual(metric(c, 'semanticPrecision')!.unexpected.map((u) => u.reason.match(/"(.+?)"/)![1]).sort(), []);
  assert.equal(ratio('provenanceCompleteness'), '0/1');
  // The forbidden "It" concept is now genuinely absent (see comment
  // above), so spuriousFactAvoidance is 1/1, not 0/1.
  assert.equal(ratio('spuriousFactAvoidance'), '1/1');
  assert.equal(ratio('capabilityRecall'), '2/2');
  assert.equal(ratio('executionClassAccuracy'), '0/1');
  assert.equal(ratio('resolutionAccuracy'), '0/1');
  assert.equal(ratio('workflowRecall'), '1/2');
  assert.equal(metric(c, 'workflowRecall')!.missing[0]!.attributedStage, 'capabilities');
  assert.equal(ratio('workflowExecutabilityAccuracy'), '0/1');
  assert.equal(ratio('executionCorrectness'), '0/1');
  assert.equal(metric(c, 'executionCorrectness')!.mismatched[0]!.attributedStage, 'execution');
});

test('REAL pipeline: the execution stage is `not_requested` when a case asks for no execution, and no execution metric is emitted', async () => {
  const report = await runSuite(suiteOf([{ caseId: 'no-exec', sources: [{ kind: 'document', path: SYNTHETIC }], expect: { capabilities: { items: [{ id: 'c', name: { equals: 'Claim Assessment' } }] } } }]), { sourceRoot: REPO_ROOT });
  const c = only(report);
  assert.equal(c.stages.execution.status, 'not_requested');
  assert.equal(metric(c, 'executionCorrectness'), undefined);
});

test('REAL pipeline, execution-input handling: an invalid input is reported by the runtime path as invalid_input (not a crash, not a success); an unimplemented capability is honestly not_executable', async () => {
  const report = await runSuite(
    suiteOf([
      {
        caseId: 'inputs',
        xoir: MECHANICS_XOIR,
        expect: {},
        execution: [
          { id: 'invalid', kind: 'capability', target: { equals: 'Check claim threshold' }, input: { claim_amount: 'a lot' }, expect: { outcome: 'invalid_input' } },
          { id: 'missing', kind: 'capability', target: { equals: 'Check claim threshold' }, input: {}, expect: { outcome: 'invalid_input' } },
          { id: 'unresolved', kind: 'capability', target: { equals: 'Assess the overall situation' }, input: {}, expect: { outcome: 'not_executable' } },
          { id: 'should-have-run', kind: 'capability', target: { equals: 'Assess the overall situation' }, input: {}, expect: { outcome: 'succeeded' } },
          { id: 'no-such-target', kind: 'capability', target: { equals: 'Nope' }, expect: { outcome: 'succeeded' } },
        ],
      },
    ]),
    { sourceRoot: REPO_ROOT },
  );
  const c = only(report);
  const byId = Object.fromEntries(c.items.filter((i) => i.dimension === 'execution').map((i) => [i.id, i]));
  assert.equal(byId['invalid']!.outcome, 'passed');
  assert.equal(byId['missing']!.outcome, 'passed');
  assert.equal(byId['unresolved']!.outcome, 'passed');
  assert.equal(byId['should-have-run']!.outcome, 'failed');
  assert.equal(byId['should-have-run']!.attributedStage, 'capabilities', 'the runtime cannot run what compilation left unresolved');
  assert.equal(byId['no-such-target']!.attributedStage, 'capabilities');
});

test('REAL pipeline, hand-built XOIR entry: source ingestion is reported as skipped (never faked); contracts, workflows and the runtime are exercised — including a genuinely injected producer value', async () => {
  const report = await runSuite(
    suiteOf([
      {
        caseId: 'mechanics',
        xoir: MECHANICS_XOIR,
        expect: { compile: { outcome: 'succeeds' } },
        execution: [
          { id: 'inject-true', kind: 'workflow', steps: [{ equals: 'Check claim threshold' }, { equals: 'Authorize payout' }], input: { claim_amount: 15000, payout_amount: 800 }, expect: { status: 'completed', injections: [{ producer: { equals: 'Check claim threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched' }] } },
          { id: 'inject-false', kind: 'workflow', steps: [{ equals: 'Check claim threshold' }, { equals: 'Authorize payout' }], input: { claim_amount: 1, payout_amount: 800 }, expect: { status: 'completed', injections: [{ producer: { equals: 'Check claim threshold' }, output: 'matched', consumer: { equals: 'Authorize payout' }, input: 'matched' }] } },
          { id: 'never-injects', kind: 'workflow', steps: [{ equals: 'Check claim threshold' }, { equals: 'Authorize payout' }], input: { claim_amount: 15000, payout_amount: 800 }, expect: { status: 'completed', injections: [{ producer: { equals: 'Authorize payout' }, output: 'matched', consumer: { equals: 'Check claim threshold' }, input: 'claim_amount' }] } },
        ],
      },
    ]),
    { sourceRoot: REPO_ROOT },
  );
  const c = only(report);
  assert.equal(c.entry, 'xoir');
  assert.equal(c.stages.compile.status, 'skipped');
  assert.match(c.stages.compile.note ?? '', /source ingestion\/extraction is not exercised/);
  assert.deepEqual([c.stages.capabilities.status, c.stages.workflows.status, c.stages.execution.status], ['ok', 'ok', 'ok']);
  assert.equal(metric(c, 'compileOutcomeAccuracy')!.ratio, 1);
  const transfer = metric(c, 'runtimeDataFlowTransfer')!;
  assert.equal(`${transfer.numerator}/${transfer.denominator}`, '2/3', 'the value transfer is verified against what the consumer was ACTUALLY executed with; an injection that never happened is caught');
  assert.equal(transfer.missing[0]!.id, 'never-injects');
});

test('REAL pipeline, compile failure: a source the compiler rejects is a `compile` stage failure — downstream stages skipped, expected items missing and attributed to compile, and an EXPECTED failure counts as correct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-bm-compilefail-'));
  try {
    await writeFile(join(dir, 'empty.txt'), '   \n\n');
    const report = await runSuite(
      suiteOf([
        { caseId: 'unexpected-failure', sources: [{ kind: 'document', path: 'empty.txt' }], expect: { compile: { outcome: 'succeeds' }, capabilities: { items: [{ id: 'cap', name: { contains: 'anything' } }] } } },
        { caseId: 'expected-failure', sources: [{ kind: 'document', path: 'empty.txt' }], expect: { compile: { outcome: 'fails' } } },
      ]),
      { sourceRoot: dir },
    );
    const unexpected = report.cases.find((c) => c.caseId === 'unexpected-failure')!;
    assert.equal(unexpected.stages.compile.status, 'failed');
    assert.ok(unexpected.stages.compile.errorCode);
    assert.deepEqual([unexpected.stages.capabilities.status, unexpected.stages.workflows.status], ['skipped', 'skipped']);
    assert.equal(metric(unexpected, 'compileOutcomeAccuracy')!.ratio, 0);
    assert.equal(metric(unexpected, 'capabilityRecall')!.missing[0]!.attributedStage, 'compile');
    const expected = report.cases.find((c) => c.caseId === 'expected-failure')!;
    assert.equal(metric(expected, 'compileOutcomeAccuracy')!.ratio, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REAL pipeline, harness error: an unreadable fixture is a HARNESS error — reported loudly, excluded from every metric, and it does not disturb the other cases', async () => {
  const report = await runSuite(
    suiteOf([
      { caseId: 'a-missing-file', sources: [{ kind: 'document', path: 'examples/vertical-test/does-not-exist.txt' }], expect: { semantics: { facts: [{ id: 'f', kind: 'concept', identify: [{ path: 'definition', exists: true }] }] } } },
      { caseId: 'b-fine', sources: [{ kind: 'document', path: SYNTHETIC }], expect: { capabilities: { items: [{ id: 'c', name: { equals: 'Claim Assessment' } }] } } },
      { caseId: 'c-bad-xoir', xoir: 'examples/vertical-test/synthetic-claim-rules.txt', expect: {} },
    ]),
    { sourceRoot: REPO_ROOT },
  );
  assert.equal(report.harnessErrorCount, 2);
  assert.equal(report.evaluatedCaseCount, 1);
  const bad = report.cases.find((c) => c.caseId === 'a-missing-file')!;
  assert.equal(bad.status, 'harness_error');
  assert.match(bad.harnessError!, /could not read source fixture/);
  assert.deepEqual(bad.metrics, []);
  assert.match(report.cases.find((c) => c.caseId === 'c-bad-xoir')!.harnessError!, /could not read XOIR fixture .*not valid JSON/);
  const capRecall = report.aggregate.metrics.find((m) => m.id === 'capabilityRecall')!;
  assert.equal(`${capRecall.numerator}/${capRecall.denominator}`, '1/1', 'aggregates come only from evaluated cases');
  assert.equal(report.aggregate.metrics.find((m) => m.id === 'semanticRecall'), undefined, 'the harness-error case contributes no semantic denominator');
});

test('the observer never bypasses XOIR: every observed capability id is an XOIR capability node of the observed graph, and every observed workflow step is an observed capability', async () => {
  const observation = await observeCase({ caseId: 'x', sources: [{ kind: 'document', path: SYNTHETIC }], expect: {} }, { sourceRoot: REPO_ROOT });
  const capabilityNodeIds = new Set(observation.nodes.filter((n) => n.kind === 'capability').map((n) => n.id));
  assert.ok(capabilityNodeIds.size > 0);
  for (const c of observation.capabilities) assert.ok(capabilityNodeIds.has(c.capabilityId), `${c.capabilityId} is an XOIR capability node`);
  const observedIds = new Set(observation.capabilities.map((c) => c.capabilityId));
  for (const w of observation.workflows) for (const s of w.steps) assert.ok(observedIds.has(s.capabilityId));
});

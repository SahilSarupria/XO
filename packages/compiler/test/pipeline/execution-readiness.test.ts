import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { analyzeExecutionReadiness } from '../../src/pipeline/execution-readiness.js';

// Domain-neutral wording. Compiler state (what was understood) and execution state (how it can run) are SEPARATE facts.
async function readiness(text: string) {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'r.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return analyzeExecutionReadiness(r.value.graph);
}
const find = (entries: ReturnType<typeof analyzeExecutionReadiness>['entries'], needle: string) =>
  entries.find((e) => e.label.includes(needle))!;

test('a fully structured mandatory rule is resolved + deterministic, and names its required inputs', async () => {
  const { entries } = await readiness(
    '# Rules\n1.1 If the widget count exceeds 5 and the gadget is approved, the operator must log the event.\n',
  );
  const e = find(entries, 'log the event');
  assert.equal(e.compilerState, 'resolved');
  assert.equal(e.executionState, 'deterministic');
  assert.deepEqual([...e.requiredInputs].sort(), ['the gadget', 'the widget count']);
  assert.deepEqual(e.blockers, []);
});

test('an outcome that requires approval or escalation is resolved but HUMAN-required, never auto-executed', async () => {
  const { entries } = await readiness(
    '# Rules\n1.1 If the widget count exceeds 5, manager approval is required.\n1.2 If the widget count exceeds 9, escalate to the duty lead.\n',
  );
  assert.equal(find(entries, 'approval is required').executionState, 'human_required');
  assert.equal(find(entries, 'escalate to the duty lead').executionState, 'human_required');
  assert.equal(find(entries, 'approval is required').compilerState, 'resolved');
});

test('a rule with preserved exceptions is partially resolved and not executable, with the reason stated', async () => {
  const { entries } = await readiness(
    '# Rules\n1.1 If the widget count exceeds 5, the request must be rejected unless the gadget is approved.\n',
  );
  const e = find(entries, 'must be rejected');
  assert.equal(e.compilerState, 'partially_resolved');
  assert.equal(e.executionState, 'not_executable');
  assert.ok(e.blockers.some((b) => /exception/i.test(b)));
});

test('a condition that cannot be structured is unresolved (kept as text), not false and not an approval/denial', async () => {
  const { entries } = await readiness('# Rules\n1.1 If the gadget behaves oddly, the request must be rejected.\n');
  const e = find(entries, 'must be rejected');
  assert.equal(e.compilerState, 'unresolved');
  assert.equal(e.executionState, 'not_executable');
  assert.ok(e.blockers.some((b) => /condition/i.test(b)));
});

test('a permission is understood (resolved) but not executable as a mandatory rule', async () => {
  const { entries } = await readiness('# Rules\n1.1 If the widget count exceeds 9, the supplier may suspend the line.\n');
  const e = find(entries, 'may suspend');
  assert.equal(e.compilerState, 'resolved');
  assert.equal(e.executionState, 'not_executable');
  assert.ok(e.blockers.some((b) => /modality|permission/i.test(b)));
});

test('an unconditional statement is understood but has no condition to bind, so it is not executable', async () => {
  const { entries } = await readiness('# Rules\nApprove every request.\n');
  const e = find(entries, 'Approve every request');
  assert.equal(e.executionState, 'not_executable');
  assert.ok(e.blockers.some((b) => /no condition/i.test(b)));
});

test('summary counts add up and compile exposes the analysis as a result field and a diagnostic', async () => {
  const r = await compileSources(
    [
      {
        kind: 'document',
        text: '# Rules\n1.1 If the widget count exceeds 5, the operator must log the event.\n1.2 If the gadget behaves oddly, the request must be rejected.\n',
        sourcePath: 'r.md',
      },
    ],
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const er = r.value.executionReadiness!;
  assert.ok(er.entries.length >= 2);
  const sum = Object.values(er.summary.byExecutionState).reduce((a, b) => a + b, 0);
  assert.equal(sum, er.entries.length);
  assert.ok(r.value.diagnostics.some((d) => d.code === 'execution-readiness/summary'));
});

test('the analysis is deterministic and never introduces a connector or integration', async () => {
  const text = '# Rules\n1.1 If the widget count exceeds 5, notify the engineering lead.\n';
  const a = await readiness(text);
  const b = await readiness(text);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).toLowerCase().includes('"connectorid"'), false); // no connector is ever bound or invented here
});

/** PX-6 — typed goals, explainable scope selection, and lowering to Workflow IR (gaps PX-G21 to PX-G23). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '@xo/compiler';
import { composeWorkflows, type CandidateWorkflow } from '@xo/workflow-composer';
import { validateWorkflowComponent } from '@xo/workflow-ir';
import {
  buildCapabilityInventory,
  goalDigest,
  goalSpecification,
  lowerCandidateWorkflow,
  renderCondition,
  selectWorkflowScope,
} from '../src/index.js';

const DOC =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n| 3 | Publish the release notes. | The notes are online. | Release engineer |\n\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

async function compiled() {
  const r = await compileSources([{ kind: 'document', text: DOC, sourcePath: 'ops.md' }]);
  assert.ok(r.ok);
  if (!r.ok) throw new Error('compile failed');
  const workflows = composeWorkflows(r.value.graph);
  assert.ok(workflows.ok);
  if (!workflows.ok) throw new Error('compose failed');
  return { graph: r.value.graph, workflows: workflows.value, inventory: buildCapabilityInventory(r.value.graph) };
}

const named = (ws: readonly CandidateWorkflow[], step: string): CandidateWorkflow =>
  ws.find((w) => w.steps.some((s) => s.capabilityName === step))!;

test('a goal selects the workflow of the right section, with its reasons; a vague goal gets one question, not a guess', async () => {
  const { workflows } = await compiled();
  const release = selectWorkflowScope(
    workflows,
    goalSpecification({ text: 'Ship a new release of the software', needs: ['Run the full test suite'] }),
  );
  assert.equal(release.status, 'selected');
  if (release.status === 'selected') {
    assert.equal(release.workflowId, named(workflows, 'Run the full test suite').id);
    assert.match(release.rationale, /needed step "Run the full test suite"/);
  }
  const none = selectWorkflowScope(workflows, goalSpecification({ text: 'Plan the office party' }));
  assert.equal(none.status, 'no_match');
  const twins = [named(workflows, 'Run the full test suite'), { ...named(workflows, 'Run the full test suite'), id: 'cw_twin' }];
  const vague = selectWorkflowScope(twins, goalSpecification({ text: 'release' }));
  assert.equal(vague.status, 'needs_clarification');
  if (vague.status === 'needs_clarification') assert.equal(vague.options.length, 2);
  assert.throws(() => goalSpecification({ text: '  ' }));
  assert.equal(goalDigest(goalSpecification({ text: 'x', statedBy: 'a' })), goalDigest(goalSpecification({ text: 'x', statedBy: 'b' })));
});

test('a procedure lowers to approve steps in order, valid Workflow IR, with a digest that survives regeneration', async () => {
  const a = await compiled();
  const b = await compiled();
  const lowA = lowerCandidateWorkflow(a.graph, named(a.workflows, 'Run the full test suite'), a.inventory);
  const lowB = lowerCandidateWorkflow(b.graph, named(b.workflows, 'Run the full test suite'), b.inventory);
  assert.deepEqual(lowA.issues, []);
  assert.equal(lowA.complete, true);
  assert.equal(validateWorkflowComponent(lowA.component).valid, true);
  const def = lowA.component!.workflows[0]!;
  assert.deepEqual(
    def.steps.map((s) => s.type),
    ['approve', 'approve', 'approve'],
  );
  assert.deepEqual(def.steps[1]!.needs, [def.steps[0]!.id], 'each step needs the one before');
  assert.equal(def.steps[1]!.runIf, "previous_decision == 'approved'", 'and runs only when the person confirmed the previous task');
  assert.equal(def.steps[0]!.runIf, undefined);
  const first = def.steps[0]!;
  assert.ok(
    first.type === 'approve' &&
      first.summary.includes('Done when: The working copy matches main.') &&
      first.summary.includes('Release engineer'),
  );
  assert.ok(first.type === 'approve' && first.onTimeout === 'escalate');
  assert.equal(lowA.definitionDigest, lowB.definitionDigest);
  assert.equal(lowA.rationale.length, 3);
});

test('a rule-bound capability lowers to a decide step whose rule renders the stated condition', async () => {
  const { graph, workflows, inventory } = await compiled();
  const ruleCap = inventory.capabilities.find((c) => c.readiness.bound.strategy === 'deterministic_rule')!;
  const wf = workflows.find((w) => w.steps.some((s) => s.capabilityId === ruleCap.capabilityId))!;
  const low = lowerCandidateWorkflow(graph, wf, inventory);
  const decide = low.component!.workflows[0]!.steps.find((s) => s.type === 'decide')!;
  assert.ok(decide.type === 'decide' && decide.method.kind === 'rules');
  if (decide.type === 'decide' && decide.method.kind === 'rules') {
    assert.equal(decide.method.rules[0]!.when, 'refund_amount > 500');
    assert.equal(decide.method.onNoMatch, 'escalate');
  }
  assert.equal(low.component!.workflows[0]!.inputs['refund_amount']!.type, 'number');
  assert.equal(low.validation.valid, true, JSON.stringify(low.validation.issues));
});

test('unbound steps and conditions with no faithful rendering are reported, never invented', async () => {
  const { graph, workflows, inventory } = await compiled();
  const wf = named(workflows, 'Run the full test suite');
  const stripped = { ...inventory, capabilities: inventory.capabilities.filter((c) => c.name !== 'Run the full test suite') };
  const low = lowerCandidateWorkflow(graph, wf, stripped);
  assert.equal(low.complete, false);
  assert.ok(low.issues.some((i) => i.code === 'unbound' && i.severity === 'blocking'));
  assert.equal(low.component!.workflows[0]!.steps.length, 2);
  assert.equal(renderCondition({ type: 'temporal', relation: 'within', amount: 30, unit: 'days' }, new Map()), undefined);
  assert.equal(
    renderCondition(
      {
        type: 'and',
        operands: [
          { type: 'comparison', field: 'Amount', operator: '>=', value: 10 },
          { type: 'categorical', field: 'status', operator: '==', value: "o'k" },
        ],
      },
      new Map(),
    ),
    "(amount >= 10 && status == 'o\\'k')",
  );
});

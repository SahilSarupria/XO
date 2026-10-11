// Live contract check for the workflow start / discover / resume journey: Studio's REAL client, parsers
// and domain helpers against a REAL running @xo/api. No fakes. Usage:
//   XO_API_URL=http://127.0.0.1:4000 XO_API_KEY=xoak_... node --import tsx scripts/live-workflow-smoke.mjs [file.pdf]
// Creates a throwaway workspace and records real approvals/runs in it; use a dev API only.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { XoClient } from '../src/platform/client.ts';
import { describeResumeProblem, describeStartProblem, findActiveRun, pendingTasks, startReadiness, standaloneExecutions } from '../src/domain/work.ts';

const baseUrl = process.env.XO_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.XO_API_KEY;
const pdf = process.argv[2] ?? '../../examples/vertical-test/Aastha.pdf';
if (!apiKey) {
  console.error('XO_API_KEY is required');
  process.exit(2);
}
const results = [];
const check = (name, cond, detail = '') => {
  results.push(Boolean(cond));
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`);
};
const must = (r, what) => {
  if (!r.ok) {
    check(what, false, `${r.problem.kind} ${r.problem.status ?? ''} ${r.problem.message}`);
    done();
  }
  return r.value;
};
function done() {
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad === 0 ? 0 : 1);
}

const c = new XoClient({ baseUrl, apiKey });
const ws = must(await c.createWorkspace('workflow smoke'), 'create workspace').workspaceId;
const file = new File([readFileSync(pdf)], basename(pdf), { type: 'application/pdf' });
const src = must(await c.uploadSource(ws, file), 'upload');
const cmp = must(await c.compileSource(ws, src.sourceId), 'compile');
check('analysis succeeded', cmp.status === 'succeeded', cmp.status);

const caps = must(await c.getCapabilities(ws, cmp.compilationId), 'capabilities');
const wfs = must(await c.listWorkflows(ws), 'list workflows (parsed)');
check('workflows parse with step lists', wfs.length > 0 && wfs.every((w) => w.steps.length === w.stepCount));
const wf = wfs.filter((w) => w.executable && w.steps.length >= 2).sort((a, b) => a.steps.length - b.steps.length)[0];
check('found a runnable multi-step process', wf !== undefined);
if (!wf) done();

const before = startReadiness(wf, caps);
check('Studio sees approvals missing before start', !before.canStart && before.needApproval.length === wf.steps.length);

// the server is the authority: ask it anyway
const denied = await c.startWorkflow(ws, wf.workflowId, wf.compilationId);
check('server refuses an unapproved start with 403', !denied.ok && denied.problem.status === 403, JSON.stringify(denied));
if (!denied.ok) {
  const v = describeStartProblem(denied.problem, wf);
  check('403 carries per-step denials Studio can name', v?.kind === 'needs_approval' && v.items.length === wf.steps.length, JSON.stringify(v));
}

for (const s of wf.steps) must(await c.approveCapability(ws, wf.compilationId, s.capabilityId), `approve ${s.name.slice(0, 30)}`);
const caps2 = must(await c.getCapabilities(ws, cmp.compilationId), 'capabilities after approval');
check('Studio now sees the process as startable', startReadiness(wf, caps2).canStart);

const none = must(await c.listWorkflowRuns(ws), 'list runs (none yet)');
check('no active run before starting', findActiveRun(none, wf.workflowId, wf.compilationId) === undefined);

const run = must(await c.startWorkflow(ws, wf.workflowId, wf.compilationId), 'start');
check('run is waiting for a decision at step 1', run.status === 'waiting_for_human' && run.currentStepIndex === 0, `${run.status} ${run.currentStepIndex}`);
check('run exposes the ids a resume needs', typeof run.currentStepExecutionId === 'string' && Number.isInteger(run.revision));

const listed = must(await c.listWorkflowRuns(ws), 'list runs');
check('active run is discoverable for this process', findActiveRun(listed, wf.workflowId, wf.compilationId)?.workflowExecutionId === run.workflowExecutionId);
check('run appears as a pending task', pendingTasks(listed).some((r) => r.workflowExecutionId === run.workflowExecutionId));
const execs = must(await c.listExecutions(ws), 'list executions');
check('its step execution is set aside from standalone history', !standaloneExecutions(execs, listed).some((e) => e.executionId === run.currentStepExecutionId));

const stale = await c.resumeWorkflowRun(ws, run.workflowExecutionId, { decision: 'approve', expectedStepExecutionId: 'exe_not_current', expectedRevision: run.revision });
check('a wrong step id is a 409 with a platform reason', !stale.ok && stale.problem.status === 409 && typeof stale.problem.reason === 'string', JSON.stringify(stale));
if (!stale.ok) check('409 is explained as a recoverable change', describeResumeProblem(stale.problem)?.kind === 'conflict');
const staleRev = await c.resumeWorkflowRun(ws, run.workflowExecutionId, { decision: 'approve', expectedStepExecutionId: run.currentStepExecutionId, expectedRevision: run.revision + 5 });
check('a wrong revision is a 409', !staleRev.ok && staleRev.problem.status === 409, JSON.stringify(staleRev));
const unchanged = must(await c.getWorkflowRun(ws, run.workflowExecutionId), 'get run');
check('refused resumes changed nothing', unchanged.revision === run.revision && unchanged.currentStepIndex === 0);

const next = must(await c.resumeWorkflowRun(ws, run.workflowExecutionId, { decision: 'approve', expectedStepExecutionId: run.currentStepExecutionId, expectedRevision: run.revision }), 'resume');
check('approval advances to the next step', next.currentStepIndex === 1 || next.status === 'succeeded', `${next.status} ${next.currentStepIndex}`);
check('revision moved forward', next.revision > run.revision);
const replay = await c.resumeWorkflowRun(ws, run.workflowExecutionId, { decision: 'approve', expectedStepExecutionId: run.currentStepExecutionId, expectedRevision: run.revision });
check('replaying the old decision is refused, not applied twice', !replay.ok && replay.problem.status === 409, JSON.stringify(replay));
done();

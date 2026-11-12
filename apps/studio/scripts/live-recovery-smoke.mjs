// Live check of recovery of an INTERRUPTED run against a real @xo/api. A real interruption needs the API process to
// die mid-step, which a smoke test cannot do safely, so this DEV-ONLY script writes the exact record the platform
// itself persists for a lost driver (`withInterrupted`) into the API's data directory, then exercises the real
// resume operation through Studio's client. Usage (dev API only; needs filesystem access to its data dir):
//   XO_API_URL=... XO_API_KEY=... XO_DATA_DIR=<WORKSPACE_DATA_DIR of that API> node --import tsx scripts/live-recovery-smoke.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { XoClient } from '../src/platform/client.ts';
import { describeRecoveryProblem, recoverableRuns } from '../src/domain/work.ts';

const baseUrl = process.env.XO_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.XO_API_KEY;
const dataDir = process.env.XO_DATA_DIR;
const pdf = process.argv[2] ?? '../../examples/vertical-test/Aastha.pdf';
if (!apiKey || !dataDir) {
  console.error('XO_API_KEY and XO_DATA_DIR are required');
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
const ws = must(await c.createWorkspace('recovery smoke'), 'create workspace').workspaceId;
const src = must(await c.uploadSource(ws, new File([readFileSync(pdf)], basename(pdf), { type: 'application/pdf' })), 'upload');
const cmp = must(await c.compileSource(ws, src.sourceId), 'compile');
const wfs = must(await c.listWorkflows(ws), 'workflows');
const wf = wfs.filter((w) => w.executable && w.steps.length >= 2).sort((a, b) => a.steps.length - b.steps.length)[0];
for (const s of wf.steps) must(await c.approveCapability(ws, cmp.compilationId, s.capabilityId), 'approve');
const run = must(await c.startWorkflow(ws, wf.workflowId, wf.compilationId), 'start');
const step1 = must(
  await c.resumeWorkflowRun(ws, run.workflowExecutionId, {
    decision: 'approve',
    expectedStepExecutionId: run.currentStepExecutionId,
    expectedRevision: run.revision,
  }),
  'decide step 1',
);
check('run is now waiting at step 2', step1.currentStepIndex === 1 && step1.status === 'waiting_for_human');

// the record the platform persists when its driving process is lost mid-step (workflow-transitions.ts: withInterrupted)
const wsDir =
  readdirSync(dataDir).find((d) => d === ws) ??
  readdirSync(dataDir).find((d) => d.startsWith('ws_') && readdirSync(join(dataDir, d)).includes('workflow-executions'));
const file = join(dataDir, wsDir, 'workflow-executions', run.workflowExecutionId, 'metadata.json');
const rec = JSON.parse(readFileSync(file, 'utf8'));
rec.status = 'interrupted';
rec.steps[1].status = 'interrupted';
delete rec.pendingHumanTask;
delete rec.currentStepExecutionId;
rec.currentStepIndex = 1;
writeFileSync(file, JSON.stringify(rec));

const seen = must(await c.listWorkflowRuns(ws), 'list runs');
const rr = recoverableRuns(seen);
check(
  'Studio discovers the interrupted run as recoverable',
  rr.length === 1 && rr[0].workflowExecutionId === run.workflowExecutionId,
  JSON.stringify(seen.map((r) => r.status)),
);
const interrupted = rr[0];
check(
  'an interrupted run exposes no pending decision',
  interrupted.currentStepExecutionId === undefined && interrupted.pendingHumanTask === undefined,
);

const stale = await c.recoverWorkflowRun(ws, run.workflowExecutionId, { expectedRevision: interrupted.revision + 7 });
check(
  'a stale revision is refused with 409 and explained',
  !stale.ok && stale.problem.status === 409 && describeRecoveryProblem(stale.problem)?.kind === 'conflict',
  JSON.stringify(stale),
);
check('the refusal changed nothing', must(await c.getWorkflowRun(ws, run.workflowExecutionId), 'get').status === 'interrupted');

const oldExec = interrupted.steps[1].executionId;
const recovered = must(await c.recoverWorkflowRun(ws, run.workflowExecutionId, { expectedRevision: interrupted.revision }), 'recover');
check('it is the SAME run id', recovered.workflowExecutionId === run.workflowExecutionId);
check(
  'the run is waiting for a decision again',
  recovered.status === 'waiting_for_human' && recovered.currentStepIndex === 1,
  `${recovered.status} ${recovered.currentStepIndex}`,
);
check(
  'the interrupted step has a NEW execution id and the old one is kept on record',
  recovered.steps[1].executionId !== oldExec && (recovered.steps[1].supersededExecutionIds ?? []).includes(oldExec),
  JSON.stringify(recovered.steps[1]),
);
check(
  'step 1 keeps its original execution (not re-run)',
  recovered.steps[0].executionId === step1.steps[0].executionId && recovered.steps[0].status === 'succeeded',
);
check('no extra run was created', must(await c.listWorkflowRuns(ws), 'runs').length === 1);
const replay = await c.recoverWorkflowRun(ws, run.workflowExecutionId, { expectedRevision: interrupted.revision });
check('replaying the recovery is refused, not applied twice', !replay.ok && replay.problem.status === 409, JSON.stringify(replay));
const finish = must(
  await c.resumeWorkflowRun(ws, run.workflowExecutionId, {
    decision: 'approve',
    expectedStepExecutionId: recovered.currentStepExecutionId,
    expectedRevision: recovered.revision,
  }),
  'decide the recovered step',
);
check(
  'the recovered step can then be decided normally',
  finish.currentStepIndex === 2 || finish.status === 'succeeded',
  `${finish.status} ${finish.currentStepIndex}`,
);
done();

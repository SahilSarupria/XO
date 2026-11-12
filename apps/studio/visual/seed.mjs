// Builds the synthetic workspace the screenshots are taken from, through Studio's OWN client against the REAL API.
// Nothing is mocked: a document is uploaded, XO analyses it, rules are approved and one process is started, exactly as a
// person would. Only a throw-away API with a throw-away data directory should ever be pointed at this.
//
//   XO_API_URL=http://127.0.0.1:PORT XO_API_KEY=<synthetic key> XO_FIXTURE_PDF=<path> node --import tsx visual/seed.mjs
// (run from apps/studio so `tsx` resolves). Prints one line of JSON with non-secret facts about what it created.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { XoClient } from '../src/platform/client.ts';
import { SYNTHETIC } from './visual.config.mjs';

const baseUrl = process.env.XO_API_URL;
const apiKey = process.env.XO_API_KEY;
const pdf = process.env.XO_FIXTURE_PDF;
if (!baseUrl || !apiKey || !pdf) {
  console.error('seed: XO_API_URL, XO_API_KEY and XO_FIXTURE_PDF are required');
  process.exit(2);
}

const must = (r, what) => {
  if (!r.ok)
    throw new Error(
      `seed: ${what} failed (${r.problem.kind}${r.problem.status !== undefined ? ` ${r.problem.status}` : ''}): ${r.problem.message}`,
    );
  return r.value;
};

const client = new XoClient({ baseUrl, apiKey });
const workspaceId = must(await client.createWorkspace(SYNTHETIC.workspaceName), 'create workspace').workspaceId;
const file = new File([readFileSync(pdf)], basename(pdf), { type: 'application/pdf' });
const source = must(await client.uploadSource(workspaceId, file), 'upload the fixture document');
const analysis = must(await client.compileSource(workspaceId, source.sourceId), 'analyse the fixture document');
if (analysis.status !== 'succeeded') throw new Error(`seed: analysis ended as "${analysis.status}", not "succeeded"`);

const workflows = must(await client.listWorkflows(workspaceId), 'list processes');
// Deterministic choice: the shortest runnable multi-step process, ties broken by id.
const chosen = workflows
  .filter((w) => w.executable && w.steps.length >= 2)
  .sort((a, b) => a.steps.length - b.steps.length || a.workflowId.localeCompare(b.workflowId))[0];
if (chosen === undefined) throw new Error('seed: the fixture document produced no runnable multi-step process');

for (const step of chosen.steps)
  must(await client.approveCapability(workspaceId, chosen.compilationId, step.capabilityId), 'approve a rule');
const run = must(await client.startWorkflow(workspaceId, chosen.workflowId, chosen.compilationId), 'start the process');

console.log(JSON.stringify({ seeded: true, processes: workflows.length, startedSteps: chosen.steps.length, runStatus: run.status }));

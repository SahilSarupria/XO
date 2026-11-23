// S1-2: builds the synthetic workspaces the journeys run against, through the REAL API, as a person would. Nothing is mocked.
// Only a throw-away API with a throw-away data directory should ever be pointed at this.
//
//   XO_API_URL=… XO_OPERATOR_KEY=… XO_REVIEWER_ID=… XO_FOLDER=<an empty directory under XO_SOURCE_FOLDER_ROOTS> node visual/seed.mjs
//
// The V1 shape, kept generic: a folder with a list of four people (one has no document yet) and one document per person,
// a procedure for sending each person their document, and a second, short procedure whose two steps a person decides
// (so the Inbox and Activity have real work in them). Prints one line of JSON with non-secret facts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTHETIC } from './visual.config.mjs';

const api = process.env.XO_API_URL;
const key = process.env.XO_OPERATOR_KEY;
const reviewerId = process.env.XO_REVIEWER_ID;
const folderRoot = process.env.XO_FOLDER;
if (!api || !key || !reviewerId || !folderRoot) {
  console.error('seed: XO_API_URL, XO_OPERATOR_KEY, XO_REVIEWER_ID and XO_FOLDER are required');
  process.exit(2);
}

async function call(method, path, body, raw) {
  const headers = { authorization: `Bearer ${key}` };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${api}${path}`, { method, headers, body: payload });
  const text = await r.text();
  if (!r.ok) throw new Error(`seed: ${method} ${path.replace(/\/ws_[0-9a-f]+/, '/<ws>')} answered ${r.status}: ${text.slice(0, 300)}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

// ---- the folder: a list and each person's document ----
const folder = join(folderRoot, SYNTHETIC.folderName);
mkdirSync(join(folder, 'Documents'), { recursive: true });
writeFileSync(join(folder, 'people.csv'), `Name,Email\n${SYNTHETIC.people.map((p) => `${p.name},${p.email}`).join('\n')}\n`);
for (const p of SYNTHETIC.people.filter((x) => x.file !== undefined))
  writeFileSync(join(folder, 'Documents', p.file), `%PDF-1.4\n% Document for ${p.name}\n%%EOF\n`);

// ---- the workspace ----
const ws = (await call('POST', '/workspaces', { name: SYNTHETIC.workspaceName })).workspaceId;
const base = `/workspaces/${ws}`;
await call('POST', `${base}/members`, { identityId: reviewerId, role: 'reviewer' });

// Connect the folder; confirm what XO found in it (the list, and which document is each person's).
const conn = (await call('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder })).connection;
let confirmed = 0;
for (const p of conn.proposals) {
  await call('POST', `${base}/source-connections/${conn.connectionId}/proposals/${p.proposalId}/decision`, { decision: 'confirmed' });
  confirmed += 1;
}

// The two procedures, in plain words; every rule approved.
async function procedure(filename, text) {
  const src = await call('POST', `${base}/sources?filename=${encodeURIComponent(filename)}`, undefined, Buffer.from(text));
  const cid = (await call('POST', `${base}/sources/${src.sourceId}/compile`)).compilationId;
  const inv = (await call('GET', `${base}/compilations/${cid}/capability-inventory`)).inventory;
  for (const c of inv.capabilities)
    await call('POST', `${base}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
  return cid;
}
const sendCid = await procedure('sending-documents.md', SYNTHETIC.sendProcedure);
const checkCid = await procedure('opening-checklist.md', SYNTHETIC.checkProcedure);

// Each procedure becomes a named workflow. The checklist is certified and started, so a person has a step to decide.
const send = await call('POST', `${base}/workflow-entities`, {
  compilationId: sendCid,
  goal: { text: SYNTHETIC.sendGoal, needs: ['Email the client their document'], forEach: 'person' },
  name: SYNTHETIC.sendWorkflowName,
});
const check = await call('POST', `${base}/workflow-entities`, {
  compilationId: checkCid,
  goal: { text: SYNTHETIC.checkGoal, needs: ['Check the overnight messages'] },
  name: SYNTHETIC.checkWorkflowName,
});
if (send.workflow == null || check.workflow == null)
  throw new Error(`seed: a goal selected no workflow (${JSON.stringify((send.workflow == null ? send : check).selection).slice(0, 300)})`);
const checkId = check.workflow.workflowId;
await call('POST', `${base}/workflow-entities/${checkId}/readiness`, {});
const run = await call('POST', `${base}/workflow-entities/${checkId}/runs`, { input: {} });

console.log(
  JSON.stringify({
    seeded: true,
    proposalsConfirmed: confirmed,
    sendWorkflow: send.workflow !== null && send.workflow !== undefined,
    runState: run.state,
    pendingApprovals: (run.pendingApprovals ?? []).length,
  }),
);

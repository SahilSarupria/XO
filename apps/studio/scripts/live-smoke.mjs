// Live contract check: drives Studio's REAL client + parsers against a REAL running @xo/api.
// No fakes. Usage:
//   XO_API_URL=http://127.0.0.1:4000 XO_API_KEY=xoak_... node --import tsx scripts/live-smoke.mjs [path/to/file.pdf]
// Needs `tsx` (installed at the repo root). Creates a throwaway workspace; approves and runs
// capabilities in it (real, recorded actions), so point it at a dev API, never at production data.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { XoClient } from '../src/platform/client.ts';
import { suggestedFieldsFromFailure, reviewStateOf } from '../src/domain/review.ts';

const baseUrl = process.env.XO_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.XO_API_KEY;
const pdf = process.argv[2] ?? '../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf';
if (!apiKey) { console.error('XO_API_KEY is required'); process.exit(2); }

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond) }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`); return cond; };
const must = (r, what) => { if (!r.ok) { check(what, false, `${r.problem.kind} ${r.problem.status ?? ''} ${r.problem.code ?? ''} ${r.problem.message}`); finish(); } return r.value; };
function finish() { const bad = results.filter((r) => !r.ok).length; console.log(`\n${results.length - bad}/${results.length} checks passed`); process.exit(bad === 0 ? 0 : 1); }

const client = new XoClient({ baseUrl, apiKey });

const bad = await new XoClient({ baseUrl, apiKey: 'xoak_not_a_real_key' }).listWorkspaces();
check('bad key -> unauthenticated (401), not data', !bad.ok && bad.problem.kind === 'unauthenticated');

const ws = must(await client.createWorkspace('studio live smoke'), 'create workspace parses');
check('workspace created and parsed', ws.workspaceId.startsWith('ws_'));
check('workspace appears in list', must(await client.listWorkspaces(), 'list workspaces').some((w) => w.workspaceId === ws.workspaceId));

const file = new File([readFileSync(pdf)], basename(pdf), { type: 'application/pdf' });
const src = must(await client.uploadSource(ws.workspaceId, file), 'upload parses');
check('source uploaded', src.originalFilename === basename(pdf) && src.byteSize === file.size);

const cmp = must(await client.compileSource(ws.workspaceId, src.sourceId), 'compile parses');
check('compilation succeeded', cmp.status === 'succeeded', cmp.errorMessage);

const caps = must(await client.getCapabilities(ws.workspaceId, cmp.compilationId), 'capabilities parse');
check(`capabilities parsed (${caps.length})`, caps.length > 0);
const states = caps.reduce((a, c) => ((a[reviewStateOf(c)] = (a[reviewStateOf(c)] ?? 0) + 1), a), {});
console.log('      review states:', JSON.stringify(states));
check('every capability has page provenance or a document path', caps.every((c) => c.provenance.length > 0));

const det = caps.find((c) => c.executionClass === 'deterministic_rule');
const hitl = caps.find((c) => c.executionClass === 'human_in_the_loop');
check('found a deterministic and a human-in-the-loop capability', det && hitl);

const refused = await client.createExecution(ws.workspaceId, cmp.compilationId, det.capabilityId, {});
check('run before approval is refused by the platform (not shown as success)', !refused.ok, JSON.stringify(refused));
if (!refused.ok) console.log(`      refusal: ${refused.problem.kind} HTTP ${refused.problem.status} ${refused.problem.code}`);

const appr = must(await client.approveCapability(ws.workspaceId, cmp.compilationId, det.capabilityId), 'approve parses');
check('approval recorded', typeof appr.approvedAt === 'string');
const capsAfter = must(await client.getCapabilities(ws.workspaceId, cmp.compilationId), 'capabilities re-read');
check('approved flag now true, state = approved', reviewStateOf(capsAfter.find((c) => c.capabilityId === det.capabilityId)) === 'approved');

const bad1 = must(await client.createExecution(ws.workspaceId, cmp.compilationId, det.capabilityId, {}), 'invalid-input run returns a record');
check('empty input -> failed record (not succeeded)', bad1.status === 'failed' && bad1.errorCode === 'XO_RUNTIME_CAPABILITY_INPUT_INVALID', JSON.stringify(bad1));
const suggested = suggestedFieldsFromFailure(bad1);
check(`required field names extracted from the real message (${suggested.join(', ')})`, suggested.length > 0, bad1.errorMessage);

const apprH = must(await client.approveCapability(ws.workspaceId, cmp.compilationId, hitl.capabilityId), 'approve HITL');
void apprH;
const hRun = must(await client.createExecution(ws.workspaceId, cmp.compilationId, hitl.capabilityId, {}), 'HITL run returns a record');
console.log(`      HITL run status: ${hRun.status}${hRun.errorMessage ? ' — ' + hRun.errorMessage : ''}`);
if (hRun.status === 'waiting_for_human') {
  check('human task is pending', hRun.humanTask?.status === 'pending');
  const resolved = must(await client.resolveHumanTask(ws.workspaceId, hRun.executionId, 'reject'), 'resolve parses');
  check('resolving records the decision', resolved.humanTask?.status === 'resolved' && resolved.humanTask?.decision === 'reject', JSON.stringify(resolved));
  console.log(`      after resolve: ${resolved.status}`);
} else {
  check('HITL run failed with input error (inputs required first) — real behaviour, documented', hRun.status === 'failed', JSON.stringify(hRun));
}

const execs = must(await client.listExecutions(ws.workspaceId), 'executions parse');
check('execution history lists our runs', execs.length >= 2);
const wfs = must(await client.listWorkflows(ws.workspaceId), 'workflows parse');
check(`workflows parsed (${wfs.length}); at least one reports why it cannot run`, wfs.length > 0 && wfs.some((w) => !w.executable && w.notExecutableReasons.length > 0));

const foreign = await client.listSources('ws_00000000000000000000000000000000');
check("another workspace's id -> not_found (no leak)", !foreign.ok && foreign.problem.kind === 'not_found', JSON.stringify(foreign));

finish();

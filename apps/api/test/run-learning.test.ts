/**
 * UW-11b (ADR 0050): what a run teaches. Observations come from the run's own record; a person may record a correction and
 * propose observations as knowledge. Nothing becomes knowledge until a reviewer approves it, and nothing from a run is executable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sched } from './scheduled-batches-fixture.js';
import { standing } from './standing-approvals-fixture.js';

type Env = Parameters<Parameters<typeof sched>[0]>[0];
type Obs = { observationId: string; kind: string; item?: number; summary: string; correction?: { field: string; value: unknown } };

/** A completed batch of n people, started under a standing approval. */
async function finished(e: Env, n = 3): Promise<{ runId: string; runs: string }> {
  const s = await standing(e, { n });
  const r = await s.start(n);
  const runId = (r.body as { runId?: string }).runId;
  assert.ok(runId !== undefined, JSON.stringify(r.body));
  return { runId, runs: `${e.base}/runs/${runId}` };
}
const get = async (e: Env, url: string, headers?: Record<string, string>) => e.server.request('GET', url, undefined, headers);
const post = async (e: Env, url: string, body: unknown, headers?: Record<string, string>) => e.server.request('POST', url, body, headers);

test('UW-11b: a run lists what it taught, in plain words with no values', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    const res = await get(e, `${runs}/observations`);
    assert.equal(res.status, 200);
    const { observations } = res.json<{ observations: Obs[] }>();
    for (const o of observations) assert.ok(!o.summary.includes('example.org'), 'no recipient in a summary');
    const ids = observations.map((o) => o.observationId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^obs_[0-9a-f]{24}$/);
  });
});

test('UW-11b: a correction is stored, listed as an observation, and audited by ids only', async () => {
  await sched(async (e) => {
    const { runId, runs } = await finished(e);
    const secret = 'Corrected Name 12345';
    const res = await post(e, `${runs}/corrections`, { item: 1, field: 'subject', value: secret, reason: 'the certificate had a typo' });
    assert.equal(res.status, 201, res.bodyText);
    const { observation } = res.json<{ observation: Obs }>();
    const listed = (await get(e, `${runs}/observations`)).json<{ observations: Obs[] }>().observations;
    const mine = listed.find((o) => o.observationId === observation.observationId);
    assert.equal(mine?.kind, 'correction');
    assert.equal(mine?.item, 1);
    assert.equal(mine?.correction?.value, secret);
    const events = e.audit.events().filter((x) => x.type === 'run-learning.correction-recorded');
    assert.equal(events.length, 1);
    const text = JSON.stringify(events);
    assert.ok(!text.includes(secret) && !text.includes('typo') && !text.includes('"subject"'), 'no field, value or reason in audit');
    assert.ok(text.includes(runId));
  });
});

test('UW-11b: a correction is refused for a field the item does not have, a bad value, a missing reason or an item out of range', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e, 2);
    const bad = async (b: Record<string, unknown>) => (await post(e, `${runs}/corrections`, b)).status;
    assert.equal(await bad({ item: 0, field: 'not_a_field', value: 'x', reason: 'r' }), 400);
    assert.equal(await bad({ item: 0, field: 'Subject', value: 'x', reason: 'r' }), 400);
    assert.equal(await bad({ item: 0, field: 'subject', value: { a: 1 }, reason: 'r' }), 400);
    assert.equal(await bad({ item: 0, field: 'subject', value: 'x'.repeat(4001), reason: 'r' }), 400);
    assert.equal(await bad({ item: 0, field: 'subject', value: 'x', reason: '  ' }), 400);
    assert.equal(await bad({ item: 2, field: 'subject', value: 'x', reason: 'r' }), 400);
    assert.equal(await bad({ field: 'subject', value: 'x', reason: 'r' }), 400);
    assert.equal(await bad({ item: 0, field: 'subject', value: 'x', reason: 'r', extra: 1 }), 400);
  });
});

test("Scenario 18: a person's correction to a run becomes a proposed change set; the knowledge head moves only when a reviewer approves it", async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    const c = (await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'Right Name', reason: 'wrong spelling' })).json<{
      observation: Obs;
    }>();
    const headBefore = (await get(e, `/workspaces/${e.ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    const p = await post(e, `${runs}/learning-proposals`, { observationIds: [c.observation.observationId], note: 'for review' });
    assert.equal(p.status, 201, p.bodyText);
    const { changeSet, proposed } = p.json<{
      changeSet: { changeSetId: string; status: string; origin: { kind: string } };
      proposed: number;
    }>();
    assert.equal(proposed, 1);
    assert.equal(changeSet.status, 'proposed');
    assert.equal(changeSet.origin.kind, 'run-outcome');
    const mid = (await get(e, `/workspaces/${e.ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    assert.equal(mid, headBefore, 'the head does not move on a proposal');
    // The proposer does not approve their own run-derived knowledge; a reviewer does.
    const self = await post(e, `/workspaces/${e.ws}/knowledge/change-sets/${changeSet.changeSetId}/approve`, { reason: 'ok' });
    assert.equal(self.status, 409, self.bodyText);
    const ok = await post(e, `/workspaces/${e.ws}/knowledge/change-sets/${changeSet.changeSetId}/approve`, { reason: 'ok' }, e.reviewer);
    assert.equal(ok.status, 200, ok.bodyText);
    const after = (await get(e, `/workspaces/${e.ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    assert.notEqual(after, headBefore);
  });
});

test('UW-11b: a proposed claim cites the run it came from, and the evidence resolves while the run stands', async () => {
  await sched(async (e) => {
    const { runId, runs } = await finished(e);
    const c = (await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'N', reason: 'r' })).json<{ observation: Obs }>();
    const cs = (await post(e, `${runs}/learning-proposals`, { observationIds: [c.observation.observationId] })).json<{
      changeSet: {
        operations: {
          record: {
            type: string;
            predicate: string;
            origin: string;
            evidence: { sourceName: string; locator: { run?: { runId: string; item?: number } } }[];
          };
        }[];
      };
    }>().changeSet;
    const claim = cs.operations[0]!.record;
    assert.equal(claim.type, 'xo-run:correction');
    assert.equal(claim.predicate, 'xo-run:field.subject');
    assert.equal(claim.origin, 'stated');
    assert.equal(claim.evidence[0]!.locator.run?.runId, runId);
    assert.equal(claim.evidence[0]!.locator.run?.item, 0);
  });
});

test('UW-11b: the same observation is not proposed twice, and an unknown observation is refused', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    const c = (await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'N', reason: 'r' })).json<{ observation: Obs }>();
    const id = c.observation.observationId;
    assert.equal((await post(e, `${runs}/learning-proposals`, { observationIds: [id] })).status, 201);
    const again = await post(e, `${runs}/learning-proposals`, { observationIds: [id] });
    assert.equal(again.status, 412, again.bodyText);
    assert.match(again.bodyText, /already_proposed/);
    const unknown = await post(e, `${runs}/learning-proposals`, { observationIds: ['obs_' + '0'.repeat(24)] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.bodyText, /unknown_observation/);
    assert.equal((await post(e, `${runs}/learning-proposals`, { observationIds: [] })).status, 400);
  });
});

test('UW-11b: run-outcome claims are never executable: no pack covers xo-run', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    const c = (await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'N', reason: 'r' })).json<{ observation: Obs }>();
    const cs = (await post(e, `${runs}/learning-proposals`, { observationIds: [c.observation.observationId] })).json<{
      changeSet: { changeSetId: string };
    }>().changeSet;
    assert.equal(
      (await post(e, `/workspaces/${e.ws}/knowledge/change-sets/${cs.changeSetId}/approve`, { reason: 'ok' }, e.reviewer)).status,
      200,
    );
    const state = (await get(e, `/workspaces/${e.ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    const { verdicts } = (await get(e, `/workspaces/${e.ws}/knowledge/states/${state}/executable`)).json<{
      verdicts: { executable: boolean }[];
    }>();
    assert.ok(verdicts.length >= 1);
    assert.ok(
      verdicts.every((v) => !v.executable),
      'nothing learned from a run feeds execution',
    );
  });
});

test('UW-11b: a viewer may read observations but not record or propose; another workspace sees nothing', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    assert.equal((await post(e, `/workspaces/${e.ws}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
    const { TestServer } = await import('./test-helpers.js');
    const viewer = TestServer.authHeader((await e.server.issueAdditionalIdentity('viewer-1')).apiKey);
    assert.equal((await get(e, `${runs}/observations`, viewer)).status, 200);
    assert.equal((await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'N', reason: 'r' }, viewer)).status, 403);
    assert.equal((await post(e, `${runs}/learning-proposals`, { observationIds: ['obs_' + '1'.repeat(24)] }, viewer)).status, 403);
    const other = (await e.server.request('POST', '/workspaces', {}, viewer)).json<{ workspaceId?: string }>();
    if (other.workspaceId !== undefined) {
      const url = runs.replace(e.ws, other.workspaceId);
      assert.equal((await get(e, `${url}/observations`, viewer)).status, 404);
    }
    assert.equal(
      (await get(e, `/workspaces/ws_00000000000000000000000000000000/generated-workflows/x/runs/run_${'0'.repeat(32)}/observations`))
        .status,
      404,
    );
  });
});

test('UW-11b: audit events of learning hold ids and counts only', async () => {
  await sched(async (e) => {
    const { runs } = await finished(e);
    const c = (await post(e, `${runs}/corrections`, { item: 0, field: 'subject', value: 'Private Value', reason: 'private reason' })).json<{
      observation: Obs;
    }>();
    await post(e, `${runs}/learning-proposals`, { observationIds: [c.observation.observationId] });
    const text = JSON.stringify(e.audit.events().filter((x) => /run-learning|change-set\.proposed/.test(x.type)));
    assert.ok(!text.includes('Private') && !text.includes('example.org') && !text.includes('sha256:'));
  });
});

test('UW-11b: a run that does not exist teaches nothing and takes no correction', async () => {
  await sched(async (e) => {
    const url = `${e.base}/runs/run_${'0'.repeat(32)}`;
    assert.equal((await get(e, `${url}/observations`)).status, 404);
    assert.equal((await post(e, `${url}/corrections`, { item: 0, field: 'subject', value: 'x', reason: 'r' })).status, 404);
    assert.equal((await get(e, `${e.base}/runs/not-a-run/observations`)).status, 404);
  });
});

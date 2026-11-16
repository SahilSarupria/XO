/**
 * UW-2 (ADR 0032) — the Workflow entity: created from a conversation prompt (UAC-1), reopened with its state, approvals and
 * history after a restart, its runs continuing with the chat closed or deleted (UAC-2), many per conversation, private
 * conversation links, revision compare-and-swap across writers, and a change feed for thin clients.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScriptableTestProvider, jsonResponse } from '@xo/ai-core';
import { TestServer, withTempDir } from './test-helpers.js';
import { FsWorkflowEntityStore } from '../src/workflow-entities/entity-store.js';
import { deriveLifecycle, type WorkflowEntity } from '../src/workflow-entities/entity.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
const GOAL = { text: 'Ship a release', needs: ['Run the full test suite'] };

const route = {
  route: 'ask',
  confidence: 0.95,
  reasoning: 'x',
  standaloneQuery: 'ship a release',
  needsClarification: false,
  clarifyingQuestion: '',
};
const answer = {
  answerable: false,
  answer: '',
  confidence: 'low',
  confidenceReason: 'x',
  contradictions: [],
  gaps: [],
  followUps: [],
};
const ok = (v: object) => ({ kind: 'success' as const, response: jsonResponse(v, { inputTokens: 1, outputTokens: 1 }, 'gemini-test') });

interface Detail {
  workflowId: string;
  name: string;
  revision: number;
  lifecycle: string;
  origin: { via: string; conversation?: { conversationId?: string; messageId?: string; available?: boolean; linked?: boolean } };
  currentVersion: { version: number; definition: { definitionId: string }; certificate?: { status: string } };
  versions: unknown[];
  pendingApprovals: { runId: string; approvalId: string; summary: string }[];
  runs: { runId: string; state: string; version: number }[];
  history: { revision: number; kind: string }[];
}
interface Summary {
  workflowId: string;
  lifecycle: string;
  conversationId?: string;
  pendingApprovals: number;
}

async function withServers(fn: (c: { start: () => Promise<TestServer>; dataDir: string }) => Promise<void>): Promise<void> {
  await withTempDir('xo-api-wfl-data-', async (dataDir) =>
    withTempDir('xo-api-wfl-ws-', async (workspacesDir) => {
      // With sources in the workspace, every turn asks the model twice: to route the message, then to answer it.
      const start = () => {
        const provider = new ScriptableTestProvider(
          'gemini',
          Array.from({ length: 40 }, (_, i) => ok(i % 2 === 0 ? route : answer)),
        );
        return TestServer.start(
          { workspaceDataDir: dataDir, workspacesDir, ...NO_OCR, chatProviderFactory: (id) => (id === 'gemini' ? provider : undefined) },
          'wfl-owner',
        );
      };
      await fn({ start, dataDir });
    }),
  );
}

/** A workspace with a compiled, capability-approved release procedure (two human steps). */
async function prepare(server: TestServer): Promise<{ ws: string; base: string; cid: string }> {
  const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
  const base = `/workspaces/${ws}`;
  await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'gemini', model: 'gemini-test' } } });
  const src = (await server.request('POST', `${base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{ sourceId: string }>();
  const cid = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
  const inv = (await server.request('GET', `${base}/compilations/${cid}/capability-inventory`)).json<{
    inventory: { capabilities: { capabilityId: string }[] };
  }>().inventory;
  for (const c of inv.capabilities)
    await server.request('POST', `${base}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
  return { ws, base, cid };
}

async function conversationWithPrompt(server: TestServer, base: string, prompt: string, h: Record<string, string> = {}) {
  const id = (await server.request('POST', `${base}/intelligence/conversations`, {}, h)).json<{ conversationId: string }>().conversationId;
  const turn = await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: prompt }, h);
  assert.equal(turn.status, 201, turn.bodyText);
  const c = (await server.request('GET', `${base}/intelligence/conversations/${id}`, undefined, h)).json<{
    messages: { messageId: string; role: string }[];
  }>();
  return {
    conversationId: id,
    messageId: c.messages.find((m) => m.role === 'user')!.messageId,
    replyId: c.messages.find((m) => m.role === 'assistant')!.messageId,
  };
}

test('UAC-1: a workflow created from a conversation prompt is one new Workflow entity with originConversationId; nothing is installed', async () => {
  await withServers(async ({ start, dataDir }) => {
    const server = await start();
    try {
      const { ws, base, cid } = await prepare(server);
      const { conversationId, messageId } = await conversationWithPrompt(server, base, 'Ship a release');
      const libraryBefore = (await server.request('GET', `${base}/library/installs`)).bodyText;
      const packagesBefore = await readdir(join(dataDir, ws, 'packages')).catch(() => []);

      const created = await server.request('POST', `${base}/workflow-entities`, {
        conversationId,
        messageId,
        compilationId: cid,
        goal: GOAL,
      });
      assert.equal(created.status, 201, created.bodyText);
      const wf = created.json<{ workflow: Detail }>().workflow;
      assert.match(wf.workflowId, /^wfl_[0-9a-f]{32}$/);
      assert.equal(wf.origin.via, 'conversation');
      assert.equal(wf.origin.conversation?.conversationId, conversationId);
      assert.equal(wf.origin.conversation?.messageId, messageId);
      assert.equal(wf.lifecycle, 'draft', 'no certificate yet');
      assert.equal(wf.versions.length, 1);
      assert.deepEqual(
        wf.history.map((h) => h.kind),
        ['created'],
      );

      const all = (await server.request('GET', `${base}/workflow-entities`)).json<{ workflows: Summary[] }>().workflows;
      assert.deepEqual(
        all.map((w) => w.workflowId),
        [wf.workflowId],
        'exactly one Workflow entity',
      );
      assert.equal((await server.request('GET', `${base}/library/installs`)).bodyText, libraryBefore, 'the XO environment is unchanged');
      assert.deepEqual(await readdir(join(dataDir, ws, 'packages')).catch(() => []), packagesBefore, 'no package was created');

      // The goal can also be the prompt itself: the message the person wrote.
      const fromPrompt = await server.request('POST', `${base}/workflow-entities`, { conversationId, messageId, compilationId: cid });
      assert.ok(fromPrompt.status === 201 || fromPrompt.status === 200, fromPrompt.bodyText);
      if (fromPrompt.status === 201)
        assert.equal(
          fromPrompt.json<{ workflow: Detail & { currentVersion: { goalText: string } } }>().workflow.currentVersion.goalText,
          'Ship a release',
        );
    } finally {
      await server.stop();
    }
  });
});

test('UAC-2: reopening shows state, approvals and history; the run continues with the chat deleted, and everything survives a restart', async () => {
  await withServers(async ({ start }) => {
    let server = await start();
    let base = '';
    let workflowId = '';
    let conversationId = '';
    try {
      const p = await prepare(server);
      base = p.base;
      const conv = await conversationWithPrompt(server, base, 'Ship a release');
      conversationId = conv.conversationId;
      workflowId = (
        await server.request('POST', `${base}/workflow-entities`, {
          conversationId,
          messageId: conv.messageId,
          compilationId: p.cid,
          goal: GOAL,
        })
      ).json<{ workflow: Detail }>().workflow.workflowId;
      const wf = `${base}/workflow-entities/${workflowId}`;

      const noCert = await server.request('POST', `${wf}/runs`, { input: {} });
      assert.equal(noCert.status, 409, 'no certificate yet: the start is refused');
      const cert = await server.request('POST', `${wf}/readiness`, {});
      assert.equal(cert.status, 201, cert.bodyText);
      assert.equal(cert.json<{ certificate: { status: string } }>().certificate.status, 'READY');
      assert.equal((await server.request('GET', wf)).json<Detail>().lifecycle, 'ready');

      const started = await server.request('POST', `${wf}/runs`, { input: {} });
      assert.equal(started.status, 201, started.bodyText);
      const run = started.json<{ runId: string; workflowId: string; version: number }>();
      assert.equal(run.workflowId, workflowId);
      const waiting = (await server.request('GET', wf)).json<Detail>();
      assert.equal(waiting.lifecycle, 'awaiting_approval');
      assert.equal(waiting.pendingApprovals.length, 1);
      assert.match(waiting.pendingApprovals[0]!.summary, /Pull the latest code/);

      // The chat is closed for good: the conversation is deleted. The workflow and its run are untouched.
      assert.equal((await server.request('DELETE', `${base}/intelligence/conversations/${conversationId}`)).status, 200);
      const decided = await server.request('POST', `${wf}/runs/${run.runId}/approvals/${waiting.pendingApprovals[0]!.approvalId}`, {
        action: 'approve',
      });
      assert.equal(decided.status, 200, decided.bodyText);
      const after = (await server.request('GET', wf)).json<Detail>();
      assert.equal(after.origin.conversation?.available, false, 'the link is kept; the conversation is gone');
      assert.equal(after.pendingApprovals.length, 1, 'the second step now waits');
    } finally {
      await server.stop();
    }

    // A fresh process against the same data: everything is still there, and the run can be finished.
    server = await start();
    try {
      const wf = `${base}/workflow-entities/${workflowId}`;
      const reopened = (await server.request('GET', wf)).json<Detail>();
      assert.equal(reopened.lifecycle, 'awaiting_approval');
      assert.equal(reopened.runs.length, 1);
      assert.equal(reopened.pendingApprovals.length, 1);
      assert.match(reopened.pendingApprovals[0]!.summary, /Run the full test suite/);
      const runView = (await server.request('GET', `${wf}/runs/${reopened.runs[0]!.runId}`)).json<{
        decisions: { action: string; signatureVerified: boolean }[];
      }>();
      assert.deepEqual(
        runView.decisions.map((d) => [d.action, d.signatureVerified]),
        [['approve', true]],
        'history of decisions, verified',
      );
      const done = await server.request(
        'POST',
        `${wf}/runs/${reopened.runs[0]!.runId}/approvals/${reopened.pendingApprovals[0]!.approvalId}`,
        { action: 'approve' },
      );
      assert.equal(done.json<{ state: string }>().state, 'completed');
      const final = (await server.request('GET', wf)).json<Detail>();
      assert.equal(final.lifecycle, 'completed');
      assert.equal(final.pendingApprovals.length, 0);
      // The deleted conversation's workflows can no longer be listed through it (it is gone), but the workflow remains listed.
      assert.equal((await server.request('GET', `${base}/intelligence/conversations/${conversationId}/workflows`)).status, 404);
      assert.equal((await server.request('GET', `${base}/workflow-entities`)).json<{ workflows: Summary[] }>().workflows.length, 1);
    } finally {
      await server.stop();
    }
  });
});

test('two workflows in one conversation; only the conversation owner sees the link; outsiders see nothing', async () => {
  await withServers(async ({ start }) => {
    const server = await start();
    try {
      const { base, cid } = await prepare(server);
      const conv = await conversationWithPrompt(server, base, 'Ship a release');
      const make = async (name: string) =>
        (
          await server.request('POST', `${base}/workflow-entities`, {
            name,
            conversationId: conv.conversationId,
            messageId: conv.messageId,
            compilationId: cid,
            goal: GOAL,
          })
        ).json<{ workflow: Detail }>().workflow;
      const a = await make('Release for Monday');
      const b = await make('Release for Friday');
      const inConversation = (await server.request('GET', `${base}/intelligence/conversations/${conv.conversationId}/workflows`)).json<{
        workflows: Summary[];
      }>().workflows;
      assert.deepEqual(new Set(inConversation.map((w) => w.workflowId)), new Set([a.workflowId, b.workflowId]));
      assert.ok(inConversation.every((w) => w.conversationId === conv.conversationId));

      // A viewer of the workspace can read the workflow (to follow or approve it) but not see which private conversation it came from.
      assert.equal((await server.request('POST', `${base}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
      const viewer = TestServer.authHeader((await server.issueAdditionalIdentity('viewer-1')).apiKey);
      const seen = await server.request('GET', `${base}/workflow-entities/${a.workflowId}`, undefined, viewer);
      assert.equal(seen.status, 200, seen.bodyText);
      assert.deepEqual(seen.json<Detail>().origin.conversation, { store: 'cnv', linked: true });
      assert.doesNotMatch(seen.bodyText, new RegExp(conv.conversationId));
      const viewerList = (await server.request('GET', `${base}/workflow-entities`, undefined, viewer)).json<{ workflows: Summary[] }>();
      assert.ok(viewerList.workflows.every((w) => w.conversationId === undefined));
      assert.equal(
        (await server.request('GET', `${base}/intelligence/conversations/${conv.conversationId}/workflows`, undefined, viewer)).status,
        404,
      );
      assert.equal(
        (await server.request('GET', `${base}/workflow-entities?conversationId=${conv.conversationId}`, undefined, viewer)).status,
        404,
      );
      assert.equal((await server.request('POST', `${base}/workflow-entities/${a.workflowId}/pause`, {}, viewer)).status, 403, 'read only');

      // Someone with no access to the workspace cannot tell the workflow exists.
      const outsider = TestServer.authHeader((await server.issueAdditionalIdentity('outsider')).apiKey);
      assert.equal((await server.request('GET', `${base}/workflow-entities/${a.workflowId}`, undefined, outsider)).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('refusals: Studio chat threads, unknown fields, a reply as the prompt, paused and archived workflows', async () => {
  await withServers(async ({ start, dataDir }) => {
    const server = await start();
    try {
      const { ws, base, cid } = await prepare(server);
      const conv = await conversationWithPrompt(server, base, 'Ship a release');
      const post = (body: object) => server.request('POST', `${base}/workflow-entities`, body);
      const cht = await post({ conversationId: `cht_${'0'.repeat(32)}`, compilationId: cid, goal: GOAL });
      assert.equal(cht.status, 400);
      assert.match(cht.bodyText, /deprecated/);
      assert.equal((await post({ compilationId: cid, goal: GOAL, workspaceId: 'x' })).status, 400);
      assert.equal((await post({ conversationId: conv.conversationId, messageId: conv.replyId, compilationId: cid })).status, 400);
      assert.equal((await post({ messageId: conv.messageId, compilationId: cid, goal: GOAL })).status, 400);
      assert.equal((await post({ conversationId: `cnv_${'0'.repeat(32)}`, compilationId: cid, goal: GOAL })).status, 404);
      assert.equal((await post({ compilationId: cid })).status, 400, 'a goal is needed');

      const wf = (await post({ compilationId: cid, goal: GOAL })).json<{ workflow: Detail }>().workflow;
      const at = `${base}/workflow-entities/${wf.workflowId}`;
      assert.equal(wf.origin.via, 'api');
      await server.request('POST', `${at}/readiness`, {});
      assert.equal((await server.request('POST', `${at}/pause`, {})).status, 200);
      assert.equal((await server.request('POST', `${at}/pause`, {})).status, 412, 'already paused');
      assert.equal((await server.request('GET', at)).json<Detail>().lifecycle, 'paused');
      const paused = await server.request('POST', `${at}/runs`, { input: {} });
      assert.equal(paused.status, 412);
      assert.match(paused.bodyText, /workflow_paused/);
      await server.request('POST', `${at}/resume`, {});
      // UW-14d: archiving erases the workflow's token vault (and only that one).
      const vaults = join(dataDir, ws, 'token-vaults');
      await mkdir(vaults, { recursive: true });
      await writeFile(join(vaults, `${wf.workflowId}.vault`), '{}');
      await writeFile(join(vaults, 'wfl_other.vault'), '{}');
      await server.request('POST', `${at}/archive`, {});
      assert.deepEqual(await readdir(vaults), ['wfl_other.vault']);
      assert.equal((await server.request('POST', `${at}/runs`, { input: {} })).status, 412);
      assert.equal(
        (await server.request('GET', `${base}/workflow-entities`)).json<{ workflows: Summary[] }>().workflows.length,
        0,
        'archived is hidden',
      );
      assert.equal(
        (await server.request('GET', `${base}/workflow-entities?archived=true`)).json<{ workflows: Summary[] }>().workflows[0]?.lifecycle,
        'archived',
      );
      assert.deepEqual(
        (await server.request('GET', at)).json<Detail>().history.map((h) => h.kind),
        ['created', 'paused', 'resumed', 'archived'],
      );
    } finally {
      await server.stop();
    }
  });
});

test('versions, compare-and-swap on expectedRevision, and the change feed', async () => {
  await withServers(async ({ start }) => {
    const server = await start();
    try {
      const { base, cid } = await prepare(server);
      const listed = (await server.request('GET', `${base}/workflow-entities`)).json<{ changesCursor: string }>();
      const wf = (await server.request('POST', `${base}/workflow-entities`, { compilationId: cid, goal: GOAL })).json<{
        workflow: Detail;
      }>().workflow;
      const at = `${base}/workflow-entities/${wf.workflowId}`;

      const same = await server.request('POST', `${at}/versions`, {});
      assert.equal(same.status, 412, 'an identical version is refused');
      const v2 = await server.request('POST', `${at}/versions`, {
        goal: { text: 'Ship a release', needs: ['Pull the latest code'] },
        note: 'start from main',
      });
      assert.equal(v2.status, 201, v2.bodyText);
      const after = v2.json<{ workflow: Detail }>().workflow;
      assert.equal(after.currentVersion.version, 2);
      assert.notEqual(after.currentVersion.definition.definitionId, wf.currentVersion.definition.definitionId);

      // Two writers pinned to the same revision: exactly one wins.
      const rev = after.revision;
      const results = await Promise.all([
        server.request('PATCH', at, { name: 'A', expectedRevision: rev }),
        server.request('PATCH', at, { name: 'B', expectedRevision: rev }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 412]);
      // Unpinned writers never lose a change: both land, one after the other.
      await Promise.all([server.request('PATCH', at, { name: 'C' }), server.request('PATCH', at, { name: 'D' })]);
      assert.equal((await server.request('GET', at)).json<Detail>().revision, rev + 3);

      const page = (await server.request('GET', `${base}/workflow-entities/changes?cursor=${listed.changesCursor}`)).json<{
        changes: { workflowId: string; kind: string; event?: string; revision?: number }[];
        cursor: string;
      }>();
      assert.deepEqual(
        page.changes.map((c) => c.event),
        ['created', 'version_added', 'renamed', 'renamed', 'renamed'],
      );
      assert.ok(page.changes.every((c) => c.workflowId === wf.workflowId && c.kind === 'entity'));

      // A run moving is a change too; a client long-polls from the last cursor.
      await server.request('POST', `${at}/readiness`, {});
      const t0 = Date.now();
      const quiet = (await server.request('GET', `${base}/workflow-entities/changes?cursor=${page.cursor}&wait=1`)).json<{
        changes: unknown[];
        cursor: string;
      }>();
      assert.equal(quiet.changes.length, 0);
      assert.ok(Date.now() - t0 >= 900, 'waited for a change');
      await server.request('POST', `${at}/runs`, { input: {} });
      const moved = (await server.request('GET', `${base}/workflow-entities/changes?cursor=${quiet.cursor}&wait=5`)).json<{
        changes: { kind: string; state?: string; runId?: string }[];
      }>();
      assert.deepEqual(
        moved.changes.map((c) => [c.kind, c.state]),
        [['run', 'waiting']],
      );
      assert.equal((await server.request('GET', `${base}/workflow-entities/changes?cursor=nope`)).status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('pagination: compact summaries in pages, newest first, with a stable cursor', async () => {
  await withServers(async ({ start }) => {
    const server = await start();
    try {
      const { base, cid } = await prepare(server);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(
          (await server.request('POST', `${base}/workflow-entities`, { name: `W${i}`, compilationId: cid, goal: GOAL })).json<{
            workflow: Detail;
          }>().workflow.workflowId,
        );
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const r = (
          await server.request('GET', `${base}/workflow-entities?limit=2${cursor !== undefined ? `&cursor=${cursor}` : ''}`)
        ).json<{
          workflows: Summary[];
          nextCursor?: string;
        }>();
        assert.ok(r.workflows.length <= 2);
        seen.push(...r.workflows.map((w) => w.workflowId));
        cursor = r.nextCursor;
      } while (cursor !== undefined);
      assert.deepEqual(seen, [...ids].reverse());
      assert.equal((await server.request('GET', `${base}/workflow-entities?limit=0`)).status, 400);
      assert.equal((await server.request('GET', `${base}/workflow-entities?lifecycle=nope`)).status, 400);
      assert.equal(
        (await server.request('GET', `${base}/workflow-entities?lifecycle=draft`)).json<{ workflows: Summary[] }>().workflows.length,
        5,
      );
    } finally {
      await server.stop();
    }
  });
});

test('store: two writers (two processes) on one revision — exactly one wins; the feed is whole lines in order', async () => {
  await withTempDir('xo-wfl-store-', async (dir) => {
    const a = new FsWorkflowEntityStore(dir, 'ws_1');
    const b = new FsWorkflowEntityStore(dir, 'ws_1');
    const by = { id: 'p', kind: 'human' };
    const now = new Date('2026-11-16T00:00:00Z');
    const e = await a.create(
      {
        name: 'N',
        origin: { via: 'api', createdBy: by, createdAt: now.toISOString() },
        versions: [
          {
            version: 1,
            definition: {
              kind: 'generated',
              definitionId: 'gwf_x',
              definitionDigest: 'sha256:x',
              compilationId: 'c',
              candidateWorkflowId: 'w',
            },
            goalText: 'g',
            createdAt: now.toISOString(),
            createdBy: by,
          },
        ],
      },
      now,
    );
    const outcomes = await Promise.allSettled(
      [a, b, a, b].map((s, i) => s.update(e.workflowId, 1, by, now, () => ({ next: { name: `n${i}` }, kind: 'renamed' }))),
    );
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.equal((await b.get(e.workflowId))?.revision, 2);
    assert.equal(await a.get('wfl_' + 'f'.repeat(32)), undefined);
    assert.equal(await a.get('../etc'), undefined);
    // Another workspace's store never serves this workspace's snapshot.
    assert.equal(await new FsWorkflowEntityStore(dir, 'ws_2').get(e.workflowId), undefined);

    const first = await a.changesSince(undefined);
    assert.deepEqual(
      first.changes.map((c) => c.revision),
      [1, 2],
    );
    assert.deepEqual((await b.changesSince(first.cursor)).changes, []);
    await b.update(e.workflowId, undefined, by, now, () => ({ next: { paused: true }, kind: 'paused' }));
    assert.deepEqual(
      (await a.changesSince(first.cursor)).changes.map((c) => c.event),
      ['paused'],
    );
  });
});

test('lifecycle derivation: active runs first, then the pause, then the current version', () => {
  const base = {
    schema: 'xo.workflow.v1',
    workflowId: 'wfl_1',
    workspaceId: 'w',
    revision: 2,
    name: 'n',
    origin: { via: 'api', createdBy: { id: 'p', kind: 'human' }, createdAt: '' },
    versions: [{ version: 1 }, { version: 2 }],
    paused: false,
    archived: false,
    updatedAt: '',
    updatedBy: { id: 'p', kind: 'human' },
    event: { kind: 'created', at: '', by: { id: 'p', kind: 'human' } },
  } as unknown as WorkflowEntity;
  const run = (version: number, state: string, startedAt: string, pendingApprovals = 0) => ({
    runId: startedAt,
    version,
    state,
    startedAt,
    pendingApprovals,
  });
  const d = (over: Partial<WorkflowEntity>, runs: ReturnType<typeof run>[], cert?: string, workspacePaused = false) =>
    deriveLifecycle({
      entity: { ...base, ...over },
      runs,
      workspacePaused,
      ...(cert !== undefined ? { currentCertificateStatus: cert } : {}),
    });
  assert.equal(d({}, []), 'draft');
  assert.equal(d({}, [], 'NEEDS_REVIEW'), 'draft');
  assert.equal(d({}, [], 'READY_WITH_CONDITIONS'), 'ready');
  assert.equal(d({}, [], 'READY', true), 'paused');
  assert.equal(d({ paused: true }, [run(1, 'waiting', '1', 1)]), 'awaiting_approval', 'a run in progress outranks the pause');
  assert.equal(d({}, [run(1, 'running', '1')]), 'running', 'an older version still running');
  assert.equal(d({}, [run(1, 'completed', '1')], 'READY'), 'ready', 'a finished run of an older version does not describe the current one');
  assert.equal(d({}, [run(2, 'completed', '2'), run(2, 'failed', '1')]), 'completed');
  assert.equal(d({}, [run(2, 'escalated', '2')]), 'needs_attention');
  assert.equal(d({}, [run(2, 'cancelled', '2')]), 'cancelled');
  // UW-7: undone after a failure is a failure, undone after a cancel is a cancel; a partial batch is said so.
  assert.equal(d({}, [run(2, 'compensated', '2')]), 'failed');
  assert.equal(d({}, [{ ...run(2, 'compensated', '2'), cancelled: true }]), 'cancelled');
  assert.equal(d({}, [{ ...run(2, 'failed', '2'), batchOutcome: 'partially_completed' }]), 'partially_completed');
  assert.equal(d({}, [{ ...run(2, 'failed', '2'), batchOutcome: 'none_completed' }]), 'failed');
  assert.equal(d({ archived: true }, [run(2, 'running', '2')]), 'archived');
});

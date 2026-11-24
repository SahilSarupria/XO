/**
 * S1-3b — the Ask box: `POST /workspaces/{ws}/ask`. One request, one typed answer. Covers each of the five answer kinds, that a
 * workflow which is not ready is never offered as startable, that the box starts nothing, that a caller's role bounds the answer,
 * that another workspace's document is unreachable, and that the audit trail carries ids and counts but never the text typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptableTestProvider, jsonResponse, type ModelProvider } from '@xo/ai-core';
import { StaticKnowledgePort } from '@xo/intelligence';
import { TestServer, withTempDir } from './test-helpers.js';

const j = (o: object) => ({ kind: 'success' as const, response: jsonResponse(o, { inputTokens: 10, outputTokens: 5 }, 'gemini-test') });
const pick = (o: object = {}) => j({ kind: 'answer', workflowId: '', place: '', goal: '', reason: '', ...o });
const route = j({
  route: 'ask',
  confidence: 0.95,
  reasoning: 'x',
  standaloneQuery: 'status of project alpha',
  needsClarification: false,
  clarifyingQuestion: '',
});
const grounded = j({
  answerable: true,
  answer: 'Alpha is delayed by customs [E1].',
  confidence: 'high',
  confidenceReason: 'Clear.',
  contradictions: [],
  gaps: [],
  followUps: [],
});
const evidence = [
  {
    id: 'doc-1',
    sourceId: 's1',
    sourceName: 'Weekly update',
    excerpt: 'Project Alpha shipment is held at customs.',
    asOf: '2026-10-30T00:00:00Z',
  },
];

const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
const GOAL = { text: 'Ship a release', needs: ['Run the full test suite'] };
const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };

/** A scripted provider whose script can grow while the test runs (a workflow id exists only after the workflow is made). */
class QueueProvider extends ScriptableTestProvider {
  private readonly queue: ReturnType<typeof j>[] = [];
  constructor(initial: ReturnType<typeof j>[]) {
    super('gemini', []);
    this.queue.push(...initial);
  }
  push(...more: ReturnType<typeof j>[]): void {
    this.queue.push(...more);
  }
  override async complete(request: Parameters<ScriptableTestProvider['complete']>[0]) {
    this.callLog.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('unscripted model call');
    return next.response;
  }
}

interface Answer {
  kind: string;
  [k: string]: unknown;
}
type Env = { server: TestServer; base: string; provider: QueueProvider };

async function withApp(script: ReturnType<typeof j>[], fn: (e: Env) => Promise<void>, withModel = true): Promise<void> {
  await withTempDir('xo-ask-data-', async (dataDir) =>
    withTempDir('xo-ask-ws-', async (workspacesDir) => {
      const provider = new QueueProvider(script);
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        ...NO_OCR,
        chatProviderFactory: (id): ModelProvider | undefined => (id === 'gemini' ? provider : undefined),
        intelligenceKnowledge: () => new StaticKnowledgePort(evidence),
      });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        if (withModel)
          await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'gemini', model: 'gemini-test' } } });
        await fn({ server, base, provider });
      } finally {
        await server.stop();
      }
    }),
  );
}

const ask = async (e: Env, text: string, context: object = { place: 'home' }, headers: Record<string, string> = {}) => {
  const r = await e.server.request('POST', `${e.base}/ask`, { text, context }, headers);
  return { status: r.status, body: r.bodyText, answer: r.status === 200 ? r.json<{ answer: Answer }>().answer : undefined };
};

/** A compiled, capability-approved procedure and one workflow made from it (a draft: no certificate yet). */
async function withWorkflow(e: Env, name = 'Ship a release'): Promise<{ workflowId: string; cid: string }> {
  const src = (await e.server.request('POST', `${e.base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
    sourceId: string;
  }>();
  const cid = (await e.server.request('POST', `${e.base}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
  const inv = (await e.server.request('GET', `${e.base}/compilations/${cid}/capability-inventory`)).json<{
    inventory: { capabilities: { capabilityId: string }[] };
  }>().inventory;
  for (const c of inv.capabilities)
    await e.server.request('POST', `${e.base}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
  const made = await e.server.request('POST', `${e.base}/workflow-entities`, { compilationId: cid, goal: GOAL, name });
  assert.equal(made.status, 201, made.bodyText);
  return { workflowId: made.json<{ workflow: { workflowId: string } }>().workflow.workflowId, cid };
}

const runsOf = async (e: Env) => (await e.server.request('GET', `${e.base}/runs`)).json<{ runs: unknown[] }>().runs.length;

test('answer: a grounded reply carries its citations; ungrounded is said plainly, never invented', async () => {
  await withApp([pick({ kind: 'answer' }), route, grounded], async (e) => {
    const r = await ask(e, 'What is the status of Project Alpha?');
    assert.equal(r.status, 200, r.body);
    const a = r.answer!;
    assert.equal(a.kind, 'answer');
    assert.equal(a['grounded'], true);
    assert.match(String(a['text']), /customs/);
    assert.deepEqual(
      (a['citations'] as { sourceName: string }[]).map((c) => c.sourceName),
      ['Weekly update'],
    );
  });
  // Nothing in the workspace matches: the model is not asked to answer, and the reply says so.
  const zebraRoute = j({
    route: 'ask',
    confidence: 0.95,
    reasoning: 'x',
    standaloneQuery: 'zebra migration',
    needsClarification: false,
    clarifyingQuestion: '',
  });
  await withApp([pick({ kind: 'answer' }), zebraRoute], async (e) => {
    const r = await ask(e, 'What is the status of zebra migration?');
    const a = r.answer!;
    assert.equal(a.kind, 'answer');
    assert.equal(a['grounded'], false);
    assert.deepEqual(a['citations'], []);
  });
});

test('analyse: a document dropped on the box is read, with what XO found, and offered as a source', async () => {
  await withApp(
    [],
    async (e) => {
      const src = (await e.server.request('POST', `${e.base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
        sourceId: string;
      }>();
      const r = await ask(e, '', { place: 'sources', documentId: src.sourceId });
      assert.equal(r.status, 200, r.body);
      const a = r.answer!;
      assert.equal(a.kind, 'analyse');
      assert.equal(a['status'], 'succeeded');
      assert.equal(a['canUseAsSource'], true);
      assert.equal(a['fileName'], 'release.md');
      assert.match(String(a['summary']), /XO read “release\.md”/);
      assert.ok(((a['found'] as { stepCount: number }).stepCount ?? 0) >= 1, 'it found steps in the procedure');
      // The same compilation the Sources screen would make: it exists now.
      const list = (await e.server.request('GET', `${e.base}/compilations`)).json<{ compilations: { compilationId: string }[] }>();
      assert.ok(list.compilations.some((c) => c.compilationId === a['compilationId']));
    },
    false,
  );
});

test('start: a ready workflow gets a prepared start; a draft, a paused and an invented one do not; the box never starts a run', async () => {
  await withApp([], async (e) => {
    const { workflowId } = await withWorkflow(e);
    const wf = `${e.base}/workflow-entities/${workflowId}`;
    const startIt = async (context: object = { place: 'work' }, choice: object = { workflowId }) => {
      e.provider.push(pick({ kind: 'start', ...choice }));
      return (await ask(e, 'Start the release', context)).answer!;
    };

    // Draft: no certificate yet.
    let a = await startIt();
    assert.equal(a.kind, 'start');
    assert.equal(a['ready'], false);
    assert.match(String(a['why']), /check before starting/);

    // Certified: ready.
    assert.equal((await e.server.request('POST', `${wf}/readiness`, {})).status, 201);
    a = await startIt();
    assert.equal(a.kind, 'start');
    assert.equal(a['ready'], true);
    assert.equal((a['workflow'] as { workflowId: string }).workflowId, workflowId);
    assert.equal(await runsOf(e), 0, 'asking prepared a start; it did not start one');

    // "This one" on its own page, with no id from the model: the workflow on screen.
    a = await startIt({ place: 'work', workflowId }, {});
    assert.equal(a.kind, 'start');
    assert.equal((a['workflow'] as { workflowId: string }).workflowId, workflowId);

    // Paused: not ready, and it says why.
    assert.equal((await e.server.request('POST', `${wf}/pause`, {})).status, 200);
    a = await startIt();
    assert.equal(a['ready'], false);
    assert.match(String(a['why']), /paused/);
    assert.equal(await runsOf(e), 0);

    // An id the model made up is not a workflow of this workspace: no start card for it.
    a = await startIt({ place: 'home' }, { workflowId: 'wfl_' + 'a'.repeat(32) });
    assert.equal(a.kind, 'cannot');
    assert.equal(await runsOf(e), 0);
  });
});

test('start: with no matching workflow, one source read gives a proposal (creating is not starting); none read says what would help', async () => {
  await withApp([pick({ kind: 'start', goal: 'Send each client their document' })], async (e) => {
    const r = await ask(e, 'Send each client their document');
    assert.equal(r.answer!.kind, 'cannot');
    assert.match(String(r.answer!['whatWouldHelp']), /Sources/);
  });
  await withApp([pick({ kind: 'start', goal: 'Ship a release' })], async (e) => {
    const src = (await e.server.request('POST', `${e.base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
      sourceId: string;
    }>();
    const cid = (await e.server.request('POST', `${e.base}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
      .compilationId;
    const a = (await ask(e, 'Ship a release')).answer!;
    assert.equal(a.kind, 'start');
    assert.equal(a['ready'], false);
    assert.deepEqual(a['proposal'], { goal: 'Ship a release', compilationId: cid });
    const made = (await e.server.request('GET', `${e.base}/workflow-entities`)).json<{ workflows: unknown[] }>().workflows;
    assert.equal(made.length, 0, 'a proposal creates nothing until the person confirms');
    assert.equal(await runsOf(e), 0);
  });
});

test('navigate: "open the Inbox" needs no model; with no failed run there is nothing to open and it says so; a made-up place is refused', async () => {
  await withApp(
    [],
    async (e) => {
      const r = await ask(e, 'Open the Inbox', { place: 'work' });
      assert.deepEqual(r.answer, { kind: 'navigate', place: 'inbox', label: 'Inbox' });
      assert.equal(e.provider.callLog.length, 0, 'no model was asked');
      const none = await ask(e, 'Show the run that failed', { place: 'activity' });
      assert.equal(none.answer!.kind, 'cannot');
      assert.match(String(none.answer!['reason']), /No run has failed/);
    },
    false,
  );
  await withApp([pick({ kind: 'navigate', place: 'mars' })], async (e) => {
    const r = await ask(e, 'Take me to somewhere nice');
    assert.equal(r.answer!.kind, 'cannot');
  });
});

test('cannot: what the Ask box does not do is said with why; with no model chosen it says so in words, not an error', async () => {
  await withApp([pick({ kind: 'cannot', reason: 'Changing settings is done in Settings.' })], async (e) => {
    const r = await ask(e, 'Turn on dark mode and delete everything');
    assert.equal(r.answer!.kind, 'cannot');
    assert.match(String(r.answer!['reason']), /Settings/);
  });
  await withApp(
    [],
    async (e) => {
      const r = await ask(e, 'What is going on?');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.answer!.kind, 'cannot');
      assert.match(String(r.answer!['reason']), /no model/i);
    },
    false,
  );
});

test('permissions bound the answer: a viewer is never offered a start or an analysis; a reviewer-level caller can still ask', async () => {
  await withApp([pick({ kind: 'answer' }), route, grounded], async (e) => {
    assert.equal((await e.server.request('POST', `${e.base}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
    const viewer = TestServer.authHeader((await e.server.issueAdditionalIdentity('viewer-1')).apiKey);
    const asked = await ask(e, 'What is the status of Project Alpha?', { place: 'home' }, viewer);
    assert.equal(asked.answer!.kind, 'answer', 'reading is allowed');
  });
  await withApp([pick({ kind: 'start', goal: 'Ship a release' })], async (e) => {
    const src = (await e.server.request('POST', `${e.base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
      sourceId: string;
    }>();
    assert.equal((await e.server.request('POST', `${e.base}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
    const viewer = TestServer.authHeader((await e.server.issueAdditionalIdentity('viewer-1')).apiKey);
    const started = await ask(e, 'Ship a release', { place: 'home' }, viewer);
    assert.equal(started.answer!.kind, 'cannot');
    assert.match(String(started.answer!['reason']), /can look, not start/);
    const analysed = await ask(e, '', { place: 'sources', documentId: src.sourceId }, viewer);
    assert.equal(analysed.answer!.kind, 'cannot');
    const compilations = (await e.server.request('GET', `${e.base}/compilations`)).json<{ compilations: unknown[] }>().compilations;
    assert.equal(compilations.length, 0, 'the refused analysis compiled nothing');
  });
});

test("isolation: another workspace's document cannot be reached; a stranger gets 404; unknown fields and bad ids are refused", async () => {
  await withApp(
    [],
    async (e) => {
      const other = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const foreign = (await e.server.request('POST', `/workspaces/${other}/sources?filename=secret.md`, Buffer.from(PROCEDURE))).json<{
        sourceId: string;
      }>().sourceId;
      const r = await ask(e, '', { place: 'sources', documentId: foreign });
      assert.equal(r.status, 404, r.body);
      assert.doesNotMatch(r.body, /secret\.md/);
      const stranger = TestServer.authHeader((await e.server.issueAdditionalIdentity('stranger')).apiKey);
      assert.equal((await ask(e, 'Open the Inbox', { place: 'home' }, stranger)).status, 404);
      assert.equal((await ask(e, 'hello', { place: 'nowhere' })).status, 400);
      assert.equal((await ask(e, 'hello', { place: 'home', workflowId: '../etc' })).status, 400);
      assert.equal((await e.server.request('POST', `${e.base}/ask`, { text: 'hi', context: { place: 'home' }, extra: 1 })).status, 400);
      assert.equal((await e.server.request('POST', `${e.base}/ask`, { text: 'x'.repeat(2001), context: { place: 'home' } })).status, 400);
      assert.equal((await e.server.request('POST', `${e.base}/ask`, { text: '', context: { place: 'home' } })).status, 400);
    },
    false,
  );
});

test('canary: the audit trail records the kind of answer and counts, never the text typed or the reply', async () => {
  const CANARY = 'zebra-canary-7f3a-do-not-log';
  await withApp([pick({ kind: 'answer' }), route, grounded], async (e) => {
    await ask(e, `What is the status of Project Alpha? ${CANARY}`);
    await ask(e, `Open the Inbox`);
    const audit = (await e.server.request('GET', `${e.base}/audit/events`)).bodyText;
    assert.match(audit, /ask\.answered/);
    assert.doesNotMatch(audit, new RegExp(CANARY), 'the prompt text is never audited');
    assert.doesNotMatch(audit, /customs/, 'nor is the reply');
    assert.match(audit, /"kind":"answer"/);
    assert.match(audit, /"kind":"navigate"/);
  });
});

test("a question asked inside a saved conversation is saved in it; someone else's conversation is a 404; an XO that is not installed is refused", async () => {
  await withApp([pick({ kind: 'answer' }), route, grounded], async (e) => {
    const id = (await e.server.request('POST', `${e.base}/intelligence/conversations`, {})).json<{ conversationId: string }>()
      .conversationId;
    const r = await e.server.request('POST', `${e.base}/ask`, {
      text: 'What is the status of Project Alpha?',
      context: { place: 'home' },
      conversationId: id,
    });
    assert.equal(r.status, 200, r.bodyText);
    const saved = (await e.server.request('GET', `${e.base}/intelligence/conversations/${id}`)).json<{
      title: string;
      messages: { role: string; content: string; result?: { grounded: boolean } }[];
    }>();
    assert.equal(saved.title, 'What is the status of Project Alpha?');
    assert.deepEqual(
      saved.messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(saved.messages[1]!.result?.grounded, true, 'saved with its structured result, so ratings and citations work as in chat');

    assert.equal((await e.server.request('POST', `${e.base}/members`, { identityId: 'other', role: 'admin' })).status, 201);
    const other = TestServer.authHeader((await e.server.issueAdditionalIdentity('other')).apiKey);
    const theirs = await ask(e, 'hello', { place: 'home' }, other);
    assert.equal(theirs.status, 200);
    const intruder = await e.server.request('POST', `${e.base}/ask`, { text: 'hi', context: { place: 'home' }, conversationId: id }, other);
    assert.equal(intruder.status, 404, "another member's conversation looks like a missing one");
    const notInstalled = await e.server.request('POST', `${e.base}/ask`, { text: 'hi', context: { place: 'home' }, attach: ['nope'] });
    assert.equal(notInstalled.status, 400);
  });
});

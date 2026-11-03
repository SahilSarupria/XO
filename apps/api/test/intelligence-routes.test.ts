import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptableTestProvider, jsonResponse, type ModelProvider } from '@xo/ai-core';
import { StaticKnowledgePort, type KnowledgePort, type Principal } from '@xo/intelligence';
import { packBundle } from '@xo/package-sdk';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';

const j = (o: object) => ({ kind: 'success' as const, response: jsonResponse(o, { inputTokens: 10, outputTokens: 5 }, 'gemini-test') });
const route = (r: object = {}) => ({
  route: 'ask',
  confidence: 0.95,
  reasoning: 'x',
  standaloneQuery: 'status of project alpha',
  needsClarification: false,
  clarifyingQuestion: '',
  ...r,
});
const answer = (o: object = {}) => ({
  answerable: true,
  answer: 'Alpha is delayed by customs [E1].',
  confidence: 'high',
  confidenceReason: 'Clear.',
  contradictions: [],
  gaps: [],
  followUps: [],
  ...o,
});
const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);
const evidence = [
  {
    id: 'doc-1',
    sourceId: 's1',
    sourceName: 'Weekly update',
    excerpt: 'Project Alpha shipment is held at customs.',
    asOf: '2026-10-30T00:00:00Z',
  },
];

interface Turn {
  conversationId: string;
  title: string;
  assistantMessage: {
    messageId: string;
    content: string;
    result: {
      route: string;
      grounded: boolean;
      confidence: string;
      citations: { sourceName: string; index: number }[];
      notices: { code: string }[];
      learning?: { recorded: boolean; eventId: string };
    };
  };
}

async function withApp<T>(
  providers: Record<string, ModelProvider>,
  knowledge: ((role: string) => KnowledgePort) | undefined,
  fn: (c: { server: TestServer; base: string }) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        chatProviderFactory: (id) => providers[id],
        ...(knowledge !== undefined ? { intelligenceKnowledge: () => ({ retrieve: (q) => knowledge(q.principal.role).retrieve(q) }) } : {}),
      });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'gemini', model: 'gemini-test' } } });
        return await fn({ server, base });
      } finally {
        await server.stop();
      }
    }),
  );
}
const start = async (s: TestServer, base: string, h: Record<string, string> = {}) =>
  (await s.request('POST', `${base}/intelligence/conversations`, {}, h)).json<{ conversationId: string }>().conversationId;

test('ASK end to end: grounded, cited answer is returned, persisted with its structured result, and audited without text', async () => {
  const p = new ScriptableTestProvider('gemini', [j(route()), j(answer())]);
  await withApp(
    { gemini: p },
    () => new StaticKnowledgePort(evidence),
    async ({ server, base }) => {
      const id = await start(server, base);
      const r = await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, {
        message: 'What is the status of Project Alpha?',
      });
      assert.equal(r.status, 201, r.bodyText);
      const t = r.json<Turn>();
      assert.equal(t.title, 'What is the status of Project Alpha?');
      assert.equal(t.assistantMessage.result.route, 'ask');
      assert.equal(t.assistantMessage.result.grounded, true);
      assert.equal(t.assistantMessage.content, 'Alpha is delayed by customs [1].');
      assert.deepEqual(
        t.assistantMessage.result.citations.map((c) => c.sourceName),
        ['Weekly update'],
      );

      const stored = (await server.request('GET', `${base}/intelligence/conversations/${id}`)).json<{ messages: { result?: unknown }[] }>();
      assert.equal(stored.messages.length, 2);
      assert.ok(stored.messages[1]?.result);

      const audit = (await server.request('GET', `${base}/audit/events`)).bodyText;
      assert.match(audit, /intelligence\.turn/);
      assert.doesNotMatch(audit, /customs/, 'neither the question nor the answer text is audited');
    },
  );
});

test('with nothing installed the chat finds no sources and the model is never asked to answer', async () => {
  const p = new ScriptableTestProvider('gemini', [j(route())]);
  await withApp({ gemini: p }, undefined, async ({ server, base }) => {
    const id = await start(server, base);
    const t = (
      await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: 'status of Alpha?' })
    ).json<Turn>();
    assert.deepEqual(
      t.assistantMessage.result.notices.map((n) => n.code),
      ['no_sources_found'],
    );
    assert.equal(t.assistantMessage.result.confidence, 'none');
    assert.equal(p.callLog.length, 1);
  });
});

test('default knowledge source: answers from the knowledge graph of an XO installed in the workspace, and @attach scopes it', async () => {
  const graph = {
    nodes: [{ id: 'n1', label: 'Forced entry exclusion', definition: 'Burglary cover applies only where there is visible forced entry.' }],
    edges: [],
  };
  const p = new ScriptableTestProvider('gemini', [
    j(route({ standaloneQuery: 'forced entry burglary cover' })),
    j(answer({ answer: 'Burglary cover needs visible forced entry [E1].' })),
    j(route({ standaloneQuery: 'forced entry burglary cover' })),
  ]);
  await withApp({ gemini: p }, undefined, async ({ server, base }) => {
    for (const name of ['burglary_policy', 'other_policy']) {
      const pkgId = (
        await server.request(
          'POST',
          `${base}/registry/packages`,
          Buffer.from(
            await packBundle(buildFixtureBundle({ name, knowledgeGraph: name === 'burglary_policy' ? graph : { nodes: [], edges: [] } })),
          ),
        )
      ).json<{ id: string }>().id;
      assert.equal((await server.request('POST', `${base}/library/installs`, { packageId: pkgId })).status, 201);
    }
    const id = await start(server, base);
    const url = `${base}/intelligence/conversations/${id}/turns`;
    const t = (await server.request('POST', url, { message: 'Does burglary cover need forced entry?' })).json<Turn>();
    assert.equal(t.assistantMessage.result.grounded, true);
    assert.equal(t.assistantMessage.result.citations[0]?.sourceName, 'burglary_policy');
    assert.match(p.callLog[1]!.messages.at(-1)!.content, /Forced entry exclusion/);

    // Scoped to a different XO, the burglary knowledge is out of reach, so there is nothing to answer from.
    const scoped = (
      await server.request('POST', url, { message: 'Does burglary cover need forced entry?', attach: ['other_policy'] })
    ).json<Turn>();
    assert.deepEqual(
      scoped.assistantMessage.result.notices.map((n) => n.code),
      ['no_sources_found'],
    );
    assert.equal((await server.request('POST', url, { message: 'hi', attach: ['not_installed'] })).status, 400);
  });
});

test("the caller's workspace role reaches the knowledge port, so C6 can enforce what they may see", async () => {
  const seen: Principal[] = [];
  const spy: KnowledgePort = {
    retrieve: async (q) => {
      seen.push(q.principal);
      return { status: 'ok', evidence: [] };
    },
  };
  const p = new ScriptableTestProvider('gemini', [j(route())]);
  await withApp(
    { gemini: p },
    () => spy,
    async ({ server, base }) => {
      const colleague = await server.issueAdditionalIdentity('colleague');
      await server.request('POST', `${base}/members`, { identityId: 'colleague', role: 'viewer' });
      const id = await start(server, base, as(colleague));
      await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: 'status?' }, as(colleague));
      assert.equal(seen[0]?.role, 'viewer');
      assert.equal(seen[0]?.identityId, 'colleague');
    },
  );
});

test('conversations are private to their owner', async () => {
  await withApp({ gemini: new ScriptableTestProvider('gemini', []) }, undefined, async ({ server, base }) => {
    const other = await server.issueAdditionalIdentity('colleague');
    await server.request('POST', `${base}/members`, { identityId: 'colleague', role: 'viewer' });
    const id = await start(server, base);
    const url = `${base}/intelligence/conversations/${id}`;
    assert.equal((await server.request('GET', url, undefined, as(other))).status, 404);
    assert.equal((await server.request('DELETE', url, undefined, as(other))).status, 404);
    assert.equal((await server.request('POST', `${url}/turns`, { message: 'hi' }, as(other))).status, 404);
    assert.equal(
      (await server.request('GET', `${base}/intelligence/conversations`, undefined, as(other))).json<{ conversations: unknown[] }>()
        .conversations.length,
      0,
    );
  });
});

test('LEARN in conversation: a correction about the previous answer is filed for review against that answer', async () => {
  const p = new ScriptableTestProvider('gemini', [
    j(route()),
    j(answer()),
    j(route({ route: 'learn', confidence: 0.9 })),
    j({ kind: 'correction', statement: 'It was the port strike.' }),
  ]);
  await withApp(
    { gemini: p },
    () => new StaticKnowledgePort(evidence),
    async ({ server, base }) => {
      const id = await start(server, base);
      await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: 'status of Project Alpha?' });
      const t = (
        await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, {
          message: "No, that's wrong, it was the port strike",
        })
      ).json<Turn>();
      assert.equal(t.assistantMessage.result.route, 'learn');
      assert.equal(t.assistantMessage.result.learning?.recorded, true);
      assert.match(t.assistantMessage.content, /sent for review/);
    },
  );
});

test('feedback endpoint files a pending-review claim; bad ratings and unknown messages are refused', async () => {
  const p = new ScriptableTestProvider('gemini', [j(route()), j(answer())]);
  await withApp(
    { gemini: p },
    () => new StaticKnowledgePort(evidence),
    async ({ server, base }) => {
      const id = await start(server, base);
      const t = (
        await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: 'status of Project Alpha?' })
      ).json<Turn>();
      const url = `${base}/intelligence/conversations/${id}/messages/${t.assistantMessage.messageId}/feedback`;
      const ok = await server.request('POST', url, { rating: 'unhelpful', comment: 'missed the carrier email' });
      assert.equal(ok.status, 201, ok.bodyText);
      assert.equal(ok.json<{ status: string }>().status, 'pending_review');
      assert.equal((await server.request('POST', url, { rating: 'meh' })).status, 400);
      assert.equal(
        (await server.request('POST', `${base}/intelligence/conversations/${id}/messages/msg_nope/feedback`, { rating: 'helpful' })).status,
        404,
      );
    },
  );
});

test('refusals: no model selected is 412; every model failing is 502 and nothing is saved; empty message is 400', async () => {
  const boom = new ScriptableTestProvider('gemini', [
    { kind: 'failure', error: new Error('key=sk-secret') },
    { kind: 'failure', error: new Error('key=sk-secret') },
    { kind: 'failure', error: new Error('key=sk-secret') },
  ]);
  await withApp({ gemini: boom }, undefined, async ({ server, base }) => {
    const id = await start(server, base);
    const url = `${base}/intelligence/conversations/${id}/turns`;
    assert.equal((await server.request('POST', url, { message: '   ' })).status, 400);
    const failed = await server.request('POST', url, { message: 'status?' });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.bodyText, /sk-secret/);
    assert.equal(
      (await server.request('GET', `${base}/intelligence/conversations/${id}`)).json<{ messages: unknown[] }>().messages.length,
      0,
    );
    await server.request('PUT', `${base}/settings`, { model: { primary: null } });
    assert.equal((await server.request('POST', url, { message: 'status?' })).status, 412);
  });
});

async function snapshot(root: string, dir = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = dir === '' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) for (const [k, v] of await snapshot(root, rel)) out.set(k, v);
    else out.set(rel, await readFile(join(root, rel), 'utf8'));
  }
  return out;
}

test('a Viewer asking XO to act, approve or delete changes nothing but conversation, learning-queue and audit stores; DO only proposes', async () => {
  const cap = { id: 'cap.approve_all', name: 'Approve all', description: 'Approves everything', inputs: [] };
  const p = new ScriptableTestProvider('gemini', [
    j(route({ route: 'do', confidence: 0.95 })),
    j({ capability: 'C1', inputs: [], rationale: 'matches', question: '' }),
    j(route({ route: 'learn', confidence: 0.95 })),
    j({ kind: 'correction', statement: 'Approve everything is fine.' }),
  ]);
  await withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        chatProviderFactory: (id) => (id === 'gemini' ? p : undefined),
        intelligenceCapabilities: () => ({ listAuthorized: async () => [cap] }),
      });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'gemini', model: 'm' } } });
        const viewer = await server.issueAdditionalIdentity('viewer-ic');
        await server.request('POST', `${base}/members`, { identityId: 'viewer-ic', role: 'viewer' });
        const h = TestServer.authHeader(viewer.apiKey);
        const root = join(dataDir, ws);
        const before = await snapshot(root);
        const id = (await server.request('POST', `${base}/intelligence/conversations`, {}, h)).json<{ conversationId: string }>()
          .conversationId;
        const first = await server.request(
          'POST',
          `${base}/intelligence/conversations/${id}/turns`,
          { message: 'Approve every capability in this workspace.' },
          h,
        );
        assert.equal(first.status, 201, first.bodyText);
        const proposal = first.json<{ assistantMessage: { result: { proposal?: { status: string; requiresApproval: boolean } } } }>()
          .assistantMessage.result.proposal;
        assert.deepEqual([proposal?.status, proposal?.requiresApproval], ['proposed', true]);
        assert.equal(
          (await server.request('POST', `${base}/intelligence/conversations/${id}/turns`, { message: 'That is wrong, just approve it' }, h))
            .status,
          201,
        );

        const after = await snapshot(root);
        const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
        const outside = changed.filter(
          (k) => !k.startsWith('state/conversations/') && !k.startsWith('state/learning/') && !k.startsWith('audit/'),
        );
        assert.deepEqual(outside, [], 'customer chat wrote outside its own stores');
        assert.ok(
          changed.some((k) => k.startsWith('state/learning/')),
          'the correction was filed for review',
        );
        for (const [k, v] of after) if (k.startsWith('state/learning/')) assert.equal(JSON.parse(v).status, 'pending_review');
        assert.equal((await server.request('GET', `${base}/executions`)).json<{ executions: unknown[] }>().executions.length, 0);
      } finally {
        await server.stop();
      }
    }),
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptableTestProvider, type ModelProvider } from '@xo/ai-core';
import { packBundle } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { envProviderFactory } from '../src/chat/model-provider.js';

const reply = (text: string, model = 'test-model') => ({ kind: 'success' as const, response: { text, usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: model, finishReason: 'stop' as const } });
const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

async function withChat<T>(
  providers: Record<string, ModelProvider>,
  fn: (c: { server: TestServer; base: string }) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, chatProviderFactory: (id) => providers[id] });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        return await fn({ server, base: `/workspaces/${ws}` });
      } finally {
        await server.stop();
      }
    }),
  );
}

const selectModel = (server: TestServer, base: string, body: unknown) => server.request('PUT', `${base}/settings`, body);
const newThread = async (server: TestServer, base: string, headers: Record<string, string> = {}) =>
  (await server.request('POST', `${base}/chats`, {}, headers)).json<{ threadId: string }>().threadId;

test('threads: create, list, get, delete; auto-title from the first message; private to their owner', async () => {
  const p = new ScriptableTestProvider('anthropic', [reply('Hello there')]);
  await withChat({ anthropic: p }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm1' } } });
    const other = await server.issueAdditionalIdentity('colleague');
    await server.request('POST', `${base}/members`, { identityId: 'colleague', role: 'viewer' });

    const id = await newThread(server, base);
    const sent = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'What does clause 4.2 say about forced entry?' });
    assert.equal(sent.status, 201, sent.bodyText);
    const body = sent.json<{ title: string; userMessage: { role: string }; assistantMessage: { role: string; content: string; model: { provider: string; model: string } } }>();
    assert.equal(body.title, 'What does clause 4.2 say about forced entry?');
    assert.equal(body.assistantMessage.content, 'Hello there');
    assert.deepEqual(body.assistantMessage.model, { provider: 'anthropic', model: 'test-model' });

    const listed = (await server.request('GET', `${base}/chats`)).json<{ threads: { threadId: string; messageCount: number }[] }>();
    assert.deepEqual(listed.threads.map((t) => [t.threadId, t.messageCount]), [[id, 2]]);
    assert.equal((await server.request('GET', `${base}/chats/${id}`)).json<{ messages: unknown[] }>().messages.length, 2);

    assert.equal((await server.request('GET', `${base}/chats`, undefined, as(other))).json<{ threads: unknown[] }>().threads.length, 0, 'a colleague does not see my chats');
    assert.equal((await server.request('GET', `${base}/chats/${id}`, undefined, as(other))).status, 404);
    assert.equal((await server.request('DELETE', `${base}/chats/${id}`, undefined, as(other))).status, 404);
    assert.equal((await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi' }, as(other))).status, 404);

    assert.equal((await server.request('DELETE', `${base}/chats/${id}`)).status, 200);
    assert.equal((await server.request('GET', `${base}/chats/${id}`)).status, 404);
    assert.equal((await server.request('GET', `${base}/chats/not-an-id`)).status, 404);
  });
});

test('the model gets the honest system prompt plus the conversation so far; replies are remembered', async () => {
  const p = new ScriptableTestProvider('anthropic', [reply('first'), reply('second')]);
  await withChat({ anthropic: p }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm1' } } });
    const id = await newThread(server, base);
    await server.request('POST', `${base}/chats/${id}/messages`, { content: 'one' });
    await server.request('POST', `${base}/chats/${id}/messages`, { content: 'two' });
    const second = p.callLog[1]!;
    assert.equal(second.model, 'm1');
    assert.equal(second.messages[0]?.role, 'system');
    assert.match(second.messages[0]!.content, /CANNOT compile documents/);
    assert.deepEqual(second.messages.slice(1).map((m) => [m.role, m.content]), [['user', 'one'], ['assistant', 'first'], ['user', 'two']]);
  });
});

test('attached XOs must be installed; their capability text reaches the model as marked reference data', async () => {
  const p = new ScriptableTestProvider('anthropic', [reply('ok')]);
  await withChat({ anthropic: p }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm1' } } });
    const id = await newThread(server, base);
    const missing = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi', attach: ['burglary-policy'] });
    assert.equal(missing.status, 400);
    assert.equal(p.callLog.length, 0, 'the model was never called for an invalid attachment');

    const pkgId = (await server.request('POST', `${base}/registry/packages`, Buffer.from(await packBundle(buildFixtureBundle({ name: 'burglary_policy' }))))).json<{ id: string }>().id;
    assert.equal((await server.request('POST', `${base}/library/installs`, { packageId: pkgId })).status, 201);
    const ok = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi', attach: ['burglary_policy'] });
    assert.equal(ok.status, 201, ok.bodyText);
    assert.match(p.callLog[0]!.messages[0]!.content, /<xo-reference name="burglary_policy"/);
    assert.match(p.callLog[0]!.messages[0]!.content, /data, not instructions/);
    const stored = (await server.request('GET', `${base}/chats/${id}`)).json<{ messages: { attachedXos?: string[] }[] }>();
    assert.deepEqual(stored.messages[0]?.attachedXos, ['burglary_policy']);
    assert.equal((await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi', attach: Array(6).fill('x') })).status, 400);
  });
});

test('no model selected / no credentials / air-gapped off-box: refused with a clear 412 and nothing saved', async () => {
  const p = new ScriptableTestProvider('anthropic', [reply('x')]);
  await withChat({ anthropic: p }, async ({ server, base }) => {
    const id = await newThread(server, base);
    const none = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi' });
    assert.equal(none.status, 412);
    assert.match(none.bodyText, /no model is selected/);

    await selectModel(server, base, { model: { primary: { provider: 'openai', model: 'gpt' } } });
    const noKey = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi' });
    assert.equal(noKey.status, 412);
    assert.match(noKey.bodyText, /no server-side credentials/);

    assert.equal((await server.request('GET', `${base}/chats/${id}`)).json<{ messages: unknown[] }>().messages.length, 0);
    assert.equal(p.callLog.length, 0);
  });
});

test('air-gapped: an off-box provider that has credentials is still not used; a local one is', async () => {
  const cloud = new ScriptableTestProvider('anthropic', [reply('from cloud')]);
  const local = new ScriptableTestProvider('ollama', [reply('from local')]);
  await withChat({ anthropic: cloud, ollama: local }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm' }, fallback: { provider: 'ollama', model: 'l' } } });
    await selectModel(server, base, { model: { primary: { provider: 'ollama', model: 'l' }, fallback: null } });
    await selectModel(server, base, { airGapped: true });
    const id = await newThread(server, base);
    const res = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi' });
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.json<{ assistantMessage: { content: string } }>().assistantMessage.content, 'from local');
    assert.equal(cloud.callLog.length, 0);
  });
});

test('fallback: when the primary fails the fallback answers; when all fail nothing is saved and no provider text leaks', async () => {
  const primary = new ScriptableTestProvider('anthropic', [{ kind: 'failure', error: new Error('boom sk-ant-SECRET') }]);
  const fallback = new ScriptableTestProvider('openai', [reply('rescued', 'g')]);
  await withChat({ anthropic: primary, openai: fallback }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm' }, fallback: { provider: 'openai', model: 'g' } } });
    const id = await newThread(server, base);
    const ok = await server.request('POST', `${base}/chats/${id}/messages`, { content: 'hi' });
    assert.equal(ok.json<{ assistantMessage: { content: string; model: { provider: string } } }>().assistantMessage.model.provider, 'openai');

    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm' }, fallback: null } });
    const id2 = await newThread(server, base);
    const fail = await server.request('POST', `${base}/chats/${id2}/messages`, { content: 'hi' });
    assert.equal(fail.status, 502);
    assert.ok(!fail.bodyText.includes('SECRET'), 'provider error text is never relayed');
    assert.equal((await server.request('GET', `${base}/chats/${id2}`)).json<{ messages: unknown[] }>().messages.length, 0);
  });
});

test('validation, and the audit entry carries metadata but never the message text', async () => {
  const p = new ScriptableTestProvider('anthropic', [reply('answer text')]);
  await withChat({ anthropic: p }, async ({ server, base }) => {
    await selectModel(server, base, { model: { primary: { provider: 'anthropic', model: 'm' } } });
    const id = await newThread(server, base);
    for (const content of ['', '   ', 5, 'x'.repeat(8001)]) {
      assert.equal((await server.request('POST', `${base}/chats/${id}/messages`, { content })).status, 400);
    }
    await server.request('POST', `${base}/chats/${id}/messages`, { content: 'highly confidential claim details' });
    const audit = await server.request('GET', `${base}/audit/events?event=chat.message`);
    const events = audit.json<{ events: { detail: Record<string, unknown> }[] }>().events;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.detail['inputChars'], 'highly confidential claim details'.length);
    assert.ok(!audit.bodyText.includes('confidential'));
    assert.ok(!audit.bodyText.includes('answer text'));
  });
});

test('the env provider factory only builds providers that are configured, and never reads request data', () => {
  const none = envProviderFactory({});
  for (const id of ['anthropic', 'openai', 'azure-openai', 'gemini', 'ollama', 'nope']) assert.equal(none(id), undefined, id);
  assert.ok(envProviderFactory({ ANTHROPIC_API_KEY: 'k' })('anthropic') !== undefined);
  assert.equal(envProviderFactory({ AZURE_OPENAI_API_KEY: 'k' })('azure-openai'), undefined, 'azure needs an endpoint too');
  assert.ok(envProviderFactory({ XO_API_OLLAMA_ENABLED: '1' })('ollama') !== undefined);
});

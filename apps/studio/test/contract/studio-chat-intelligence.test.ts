// @vitest-environment node
/**
 * END-TO-END: Studio's real client and parsers -> the real @xo/api (customer intelligence chat) -> the real
 * GeminiProvider speaking Gemini's HTTP wire format to a local stand-in on 127.0.0.1. Nothing external is contacted.
 *
 * What this proves: a person using Studio's chat can install an XO, ask a question about it and get a cited, grounded
 * answer; ask something nothing covers and be told so; correct an answer and have it filed for review; and rate an
 * answer. What it does NOT prove: the quality of a real model's routing or wording — the stand-in below routes by
 * keyword and quotes the first evidence it is shown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { GeminiProvider } from '@xo/ai-core';
import { packBundle } from '@xo/package-sdk';
import { createHttpServer } from '../../../api/src/server';
import { FsApiKeyStore } from '../../../api/src/auth/fs-api-key-store';
import { generateApiKey, hashApiKey } from '../../../api/src/auth/api-key';
import { buildFixtureBundle } from '../../../api/test/fixtures';
import { XoClient, type Result } from '../../src/platform/client';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.problem.kind}: ${r.problem.message}`);
  return r.value;
};

/** A Gemini-protocol stand-in: decides by the response schema it is asked to fill, like the real structured-output API. */
function fakeGemini(requests: { schemaKeys: string[]; keyHeader: string | undefined; urlHasKey: boolean }[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        contents: { role: string; parts: { text: string }[] }[];
        generationConfig?: { responseSchema?: { properties?: Record<string, unknown> } };
      };
      const keys = Object.keys(body.generationConfig?.responseSchema?.properties ?? {});
      requests.push({
        schemaKeys: keys,
        keyHeader: req.headers['x-goog-api-key'] as string | undefined,
        urlHasKey: (req.url ?? '').includes('key='),
      });
      const last =
        body.contents
          .at(-1)
          ?.parts.map((p) => p.text)
          .join('') ?? '';
      let out: unknown;
      if (keys.includes('route')) {
        const wrong = /that'?s wrong|incorrect/i.test(last);
        out = {
          route: wrong ? 'learn' : 'ask',
          confidence: 0.92,
          reasoning: 'keyword',
          standaloneQuery: last.replace(/^[\s\S]*Question:\s*/, '').slice(0, 200),
          needsClarification: false,
          clarifyingQuestion: '',
        };
      } else if (keys.includes('answerable')) {
        const alias = /<xo-evidence id="(E\d+)"/.exec(last)?.[1];
        out = {
          answerable: alias !== undefined,
          answer: alias !== undefined ? `Burglary cover applies only where there is visible forced entry [${alias}].` : 'Not covered.',
          confidence: 'high',
          confidenceReason: 'The installed policy states it.',
          contradictions: [],
          gaps: [],
          followUps: ['What about theft by employees?'],
        };
      } else if (keys.includes('kind')) {
        out = { kind: 'correction', statement: 'The user says the cover also applies without forced entry.' };
      } else {
        out = {};
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
        }),
      );
    });
  });
}

let dir: string;
let api: http.Server;
let gem: http.Server;
let owner: XoClient;
let ws: string;
const geminiRequests: { schemaKeys: string[]; keyHeader: string | undefined; urlHasKey: boolean }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xo-studio-chat-'));
  gem = fakeGemini(geminiRequests);
  await new Promise<void>((r) => gem.listen(0, '127.0.0.1', r));
  const gemUrl = `http://127.0.0.1:${(gem.address() as { port: number }).port}`;

  const keys = new FsApiKeyStore(new LocalFsBlobStore(join(dir, 'k')));
  const key = generateApiKey();
  await keys.create({ keyHash: hashApiKey(key), identityId: 'owner', principalKind: 'service', createdAt: new Date().toISOString() });
  api = createHttpServer({
    apiKeyStore: keys,
    workspacesDir: join(dir, 'w'),
    workspaceDataDir: join(dir, 'd'),
    chatProviderFactory: (id) => (id === 'gemini' ? new GeminiProvider({ apiKey: 'test-key', baseUrl: gemUrl }) : undefined),
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  owner = new XoClient({ apiKey: key, baseUrl: base });

  ws = must(await owner.createWorkspace('Claims Ops', { kind: 'team', region: 'in-mumbai' })).workspaceId;
  const cur = must(await owner.getSettings(ws));
  must(
    await owner.updateSettings(ws, {
      expectedRevision: cur.settings.revision,
      model: { primary: { provider: 'gemini', model: 'gemini-test' } },
    }),
  );

  const graph = {
    nodes: [{ id: 'n1', label: 'Forced entry exclusion', definition: 'Burglary cover applies only where there is visible forced entry.' }],
    edges: [],
  };
  const archive = Buffer.from(await packBundle(buildFixtureBundle({ name: 'burglary_policy', knowledgeGraph: graph })));
  const pub = await fetch(`${base}/workspaces/${ws}/registry/packages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: archive,
  });
  expect(pub.status).toBe(201);
  must(await owner.installPackage(ws, ((await pub.json()) as { id: string }).id));
});
afterAll(async () => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => gem.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('Studio chat on the intelligence layer', () => {
  it('ASK: a question about an installed XO gets a cited, grounded answer that Studio can parse', async () => {
    const chat = must(await owner.createChat(ws));
    const reply = must(await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?'));
    const a = reply.assistantMessage;
    expect(a.content).toBe('Burglary cover applies only where there is visible forced entry [1].');
    expect(a.result).toMatchObject({ route: 'ask', grounded: true, confidence: 'high' });
    expect(a.result?.citations[0]).toMatchObject({ index: 1, sourceName: 'burglary_policy' });
    expect(a.result?.citations[0]?.excerpt).toMatch(/visible forced entry/);
    expect(a.result?.followUps).toEqual(['What about theft by employees?']);
    expect(a.model).toEqual({ provider: 'gemini', model: 'gemini-test' });
    expect(reply.title).toBe('Does burglary cover need forced entry?');
    const saved = must(await owner.getChat(ws, chat.threadId));
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.messages[1]?.result?.citations).toHaveLength(1);
  });

  it('the real Gemini adapter is used correctly on the wire: key in a header, never in the URL', () => {
    expect(geminiRequests.length).toBeGreaterThan(0);
    for (const r of geminiRequests) {
      expect(r.keyHeader).toBe('test-key');
      expect(r.urlHasKey).toBe(false);
    }
  });

  it('a question nothing installed covers is answered honestly, without a model-written answer', async () => {
    const chat = must(await owner.createChat(ws));
    const before = geminiRequests.length;
    const reply = must(await owner.sendChatMessage(ws, chat.threadId, 'What is the cafeteria menu on Friday?'));
    expect(reply.assistantMessage.result).toMatchObject({ route: 'ask', grounded: false, confidence: 'none' });
    expect(reply.assistantMessage.result?.notices.map((n) => n.code)).toEqual(['no_sources_found']);
    expect(geminiRequests.length - before).toBe(1); // routing only
  });

  it('@attach scopes the answer to the named XO, and an uninstalled name is refused', async () => {
    const chat = must(await owner.createChat(ws));
    const bad = await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?', ['not_installed']);
    expect(bad.ok).toBe(false);
    const ok = must(await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?', ['burglary_policy']));
    expect(ok.assistantMessage.result?.grounded).toBe(true);
  });

  it('LEARN: telling XO an answer is wrong files it for review against that answer and changes no answer', async () => {
    const chat = must(await owner.createChat(ws));
    must(await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?'));
    const reply = must(await owner.sendChatMessage(ws, chat.threadId, "That's wrong, it also applies without forced entry"));
    expect(reply.assistantMessage.result).toMatchObject({ route: 'learn', learning: { recorded: true, reviewRequired: true } });
    expect(reply.assistantMessage.content).toMatch(/sent for review/);
    const again = must(await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?'));
    expect(again.assistantMessage.content).toBe('Burglary cover applies only where there is visible forced entry [1].');
    const queue = join(dir, 'd');
    const files = (await readdir(queue, { recursive: true })).filter((f) => /learning[\\/]lrn_.*\.json$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) expect(JSON.parse(await readFile(join(queue, f), 'utf8')).status).toBe('pending_review');
  });

  it('rating an answer is recorded for review', async () => {
    const chat = must(await owner.createChat(ws));
    const reply = must(await owner.sendChatMessage(ws, chat.threadId, 'Does burglary cover need forced entry?'));
    const rated = must(await owner.rateChatMessage(ws, chat.threadId, reply.assistantMessage.messageId, 'helpful'));
    expect(rated.eventId).toMatch(/^lrn_/);
    const bad = await owner.rateChatMessage(ws, chat.threadId, 'msg_nope', 'helpful');
    expect(bad.ok).toBe(false);
  });
});

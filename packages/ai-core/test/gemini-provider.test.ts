import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/providers/gemini-provider.js';

const req = {
  model: 'gemini-x',
  messages: [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ],
  maxOutputTokens: 100,
};
const fakeFetch = (status: number, body: unknown) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = init?.headers as Record<string, string>;
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};

test('sends the API key in a header, never in the URL, and folds system text into systemInstruction', async () => {
  const p = new GeminiProvider({
    apiKey: 'KEY123',
    fetchImpl: fakeFetch(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    }),
  });
  const r = await p.complete(req);
  assert.equal(r.text, 'ok');
  assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 4 });
  assert.doesNotMatch(seen.url ?? '', /KEY123/);
  assert.equal(seen.headers?.['x-goog-api-key'], 'KEY123');
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(seen.body.contents[0].role, 'user');
});

test('a safety-blocked candidate (no content, no usage) is a typed content_blocked failure, not a TypeError', async () => {
  const p = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, { candidates: [{ finishReason: 'SAFETY' }] }) });
  await assert.rejects(
    () => p.complete(req),
    (e: unknown) => e instanceof Error && e.name === 'AiError' && /filtered the output/.test(e.message),
  );
});

test('a prompt blocked before generation is content_blocked; no candidates otherwise is a typed error', async () => {
  const blocked = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, { promptFeedback: { blockReason: 'SAFETY' } }) });
  await assert.rejects(() => blocked.complete(req), /blocked the prompt/);
  const empty = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, {}) });
  await assert.rejects(() => empty.complete(req), /no candidates/);
});

test('passes the response schema through as structured output', async () => {
  const p = new GeminiProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }),
  });
  await p.complete({ ...req, responseSchema: { type: 'object' } });
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
});

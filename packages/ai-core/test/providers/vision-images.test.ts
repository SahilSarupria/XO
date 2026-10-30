import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../../src/providers/anthropic-provider.js';
import { OpenAiProvider } from '../../src/providers/openai-provider.js';
import { GeminiProvider } from '../../src/providers/gemini-provider.js';
import { AzureOpenAiProvider } from '../../src/providers/azure-openai-provider.js';
import type { ProviderRequest } from '../../src/provider-types.js';

const withImage: ProviderRequest = {
  model: 'm',
  maxOutputTokens: 10,
  messages: [{ role: 'user', content: 'transcribe', images: [{ mediaType: 'image/png', dataBase64: 'QUJD' }] }],
};
const textOnly: ProviderRequest = { model: 'm', maxOutputTokens: 10, messages: [{ role: 'user', content: 'hello' }] };

function capture(response: unknown): { fetchImpl: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => response, text: async () => '' };
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

test('vision: Anthropic sends images as base64 content blocks, text-only calls are unchanged', async () => {
  const { fetchImpl, bodies } = capture({
    content: [{ type: 'text', text: '{}' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  await p.complete(withImage);
  await p.complete(textOnly);
  const [a, b] = bodies as { messages: { content: unknown }[] }[];
  assert.deepEqual(a!.messages[0]!.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'text', text: 'transcribe' },
  ]);
  assert.equal(b!.messages[0]!.content, 'hello');
});

for (const [name, make] of [
  ['OpenAI', (fetchImpl: typeof fetch) => new OpenAiProvider({ apiKey: 'k', fetchImpl })],
  [
    'Azure OpenAI',
    (fetchImpl: typeof fetch) =>
      new AzureOpenAiProvider({
        apiKey: 'k',
        endpoint: 'https://x.openai.azure.com',
        deployment: 'd',
        apiVersion: '1',
        fetchImpl,
      } as never),
  ],
] as const) {
  test(`vision: ${name} sends images as data-URL image_url parts, text-only calls are unchanged`, async () => {
    const { fetchImpl, bodies } = capture({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const p = make(fetchImpl);
    await p.complete(withImage);
    await p.complete(textOnly);
    const [a, b] = bodies as { messages: { content: unknown }[] }[];
    assert.deepEqual(a!.messages[0]!.content, [
      { type: 'text', text: 'transcribe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
    assert.equal(b!.messages[0]!.content, 'hello');
  });
}

test('vision: Gemini sends images as inlineData parts, text-only calls are unchanged', async () => {
  const { fetchImpl, bodies } = capture({
    candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
  const p = new GeminiProvider({ apiKey: 'k', fetchImpl });
  await p.complete(withImage);
  await p.complete(textOnly);
  const [a, b] = bodies as { contents: { parts: unknown[] }[] }[];
  assert.deepEqual(a!.contents[0]!.parts, [{ text: 'transcribe' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }]);
  assert.deepEqual(b!.contents[0]!.parts, [{ text: 'hello' }]);
});

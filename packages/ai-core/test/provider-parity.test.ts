import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AzureOpenAiProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAiProvider,
  type ModelProvider,
  type ProviderRequest,
} from '../src/index.js';

/**
 * Offline parity across the four adapters. Each is driven through its own wire format by a fake transport; the assertions are on the
 * NORMALIZED behaviour the rest of the system relies on, so nothing in the layer can depend on one provider's quirks unnoticed.
 * No network, no keys, no model. This shows parity on these scenarios only; it is not a statement about live model behaviour.
 */

const SECRET = 'sk-test-SECRET-key-0123456789abcdef';
const tools = [{ name: 'evaluate', description: 'run it', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }];
const req = (withTools: boolean): ProviderRequest => ({
  model: 'm',
  maxOutputTokens: 50,
  messages: [{ role: 'user', content: 'go' }],
  ...(withTools ? { tools } : {}),
});

type Scenario = 'text' | 'tool' | 'bad_args' | 'http429' | 'http500' | 'truncated_tool';

const wire: Record<string, (s: Scenario) => { status: number; body: unknown }> = {
  openai: (s) => {
    const r = (message: unknown, finish: string) => ({
      status: 200,
      body: { choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'x' },
    });
    const call = (args: string) => ({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'evaluate', arguments: args } }],
    });
    return s === 'text'
      ? r({ content: 'hello' }, 'stop')
      : s === 'tool'
        ? r(call('{"a":2}'), 'tool_calls')
        : s === 'bad_args'
          ? r(call('{"a":'), 'tool_calls')
          : s === 'truncated_tool'
            ? r(call('{"a":2}'), 'length')
            : { status: s === 'http429' ? 429 : 500, body: { error: `denied for ${SECRET}` } };
  },
  ollama: (s) => {
    const r = (message: unknown, done: string) => ({
      status: 200,
      body: { message, done_reason: done, prompt_eval_count: 10, eval_count: 5 },
    });
    const call = (args: unknown) => ({ content: '', tool_calls: [{ function: { name: 'evaluate', arguments: args } }] });
    return s === 'text'
      ? r({ content: 'hello' }, 'stop')
      : s === 'tool'
        ? r(call({ a: 2 }), 'stop')
        : s === 'bad_args'
          ? r(call('{"a":'), 'stop')
          : s === 'truncated_tool'
            ? r(call({ a: 2 }), 'length')
            : { status: s === 'http429' ? 429 : 500, body: { error: `denied for ${SECRET}` } };
  },
  gemini: (s) => {
    const r = (parts: unknown[], finish: string) => ({
      status: 200,
      body: {
        candidates: [{ content: { role: 'model', parts }, finishReason: finish }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });
    return s === 'text'
      ? r([{ text: 'hello' }], 'STOP')
      : s === 'tool'
        ? r([{ functionCall: { name: 'evaluate', args: { a: 2 } } }], 'STOP')
        : s === 'bad_args'
          ? r([{ functionCall: { name: 'evaluate', args: 'not-an-object' } }], 'STOP')
          : s === 'truncated_tool'
            ? r([{ functionCall: { name: 'evaluate', args: { a: 2 } } }], 'MAX_TOKENS')
            : { status: s === 'http429' ? 429 : 500, body: { error: { message: `denied for ${SECRET}` } } };
  },
};
wire['azure'] = wire['openai'] as (typeof wire)[string];

const fakeFor = (kind: string, s: Scenario): typeof fetch =>
  (async () => {
    const { status, body } = (wire[kind] as (s: Scenario) => { status: number; body: unknown })(s);
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;

const make = (kind: 'openai' | 'azure' | 'ollama' | 'gemini', s: Scenario): ModelProvider => {
  const fetchImpl = fakeFor(kind === 'azure' ? 'azure' : kind, s);
  if (kind === 'openai') return new OpenAiProvider({ apiKey: SECRET, fetchImpl });
  if (kind === 'azure') return new AzureOpenAiProvider({ apiKey: SECRET, endpoint: 'https://r.openai.azure.com', fetchImpl });
  if (kind === 'ollama') return new OllamaProvider({ fetchImpl });
  return new GeminiProvider({ apiKey: SECRET, fetchImpl });
};
const KINDS = ['openai', 'azure', 'ollama', 'gemini'] as const;

describe('provider parity (offline, fake transports)', () => {
  for (const k of KINDS) {
    it(`${k}: plain text normalizes to the same response shape and token usage`, async () => {
      const r = await make(k, 'text').complete(req(false));
      assert.equal(r.finishReason, 'stop');
      assert.equal(r.text, 'hello');
      assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens], [10, 5]);
      assert.ok(r.toolCalls === undefined || r.toolCalls.length === 0);
    });
    it(`${k}: a tool call normalizes to name + object input, finishReason tool_use`, async () => {
      const r = await make(k, 'tool').complete(req(true));
      assert.equal(r.finishReason, 'tool_use');
      assert.equal(r.toolCalls?.length, 1);
      assert.equal(r.toolCalls?.[0]?.name, 'evaluate');
      assert.deepEqual(r.toolCalls?.[0]?.input, { a: 2 });
    });
    it(`${k}: malformed tool arguments fail closed instead of calling the tool with {}`, async () => {
      await assert.rejects(make(k, 'bad_args').complete(req(true)));
    });
    it(`${k}: a tool call on a truncated reply is refused`, async () => {
      await assert.rejects(make(k, 'truncated_tool').complete(req(true)));
    });
    for (const s of ['http429', 'http500'] as const)
      it(`${k}: ${s} surfaces as the same typed provider error and never leaks the API key`, async () => {
        const e = await make(k, s)
          .complete(req(false))
          .then(
            () => undefined,
            (x: Error & { code?: string }) => x,
          );
        assert.ok(e !== undefined, 'must reject');
        assert.equal(e.code, 'XO_AI_PROVIDER_REQUEST_FAILED');
        if (k !== 'ollama') assert.ok(!e.message.includes(SECRET), `${k} leaked the key in: ${e.message}`); // Ollama has no API key to leak
      });
    it(`${k}: declares tool-calling support, so hosts can negotiate the same level for all of them`, () => {
      assert.equal(make(k, 'text').describeCapabilities().supportsToolCalling, true);
    });
  }
});

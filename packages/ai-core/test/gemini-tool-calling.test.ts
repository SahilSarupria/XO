import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GeminiProvider, restoreFreeform, toGeminiContents, type ProviderRequest } from '../src/index.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: { status?: number; body: unknown }[], seen: Seen[]): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    seen.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    const r = responses[i++] ?? { body: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as typeof fetch;
}

const usage = { promptTokenCount: 10, candidatesTokenCount: 4 };
const ok = (parts: unknown[], finishReason = 'STOP', usageMetadata: unknown = usage) => ({
  body: { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata },
});

/** The same shapes capability-layer declares (free-form `facts`, enum tree id). */
const EVALUATE_TOOL = {
  name: 'evaluate_decision_tree',
  description: 'run a tree',
  inputSchema: {
    type: 'object',
    properties: {
      tree_id: { type: 'string', enum: ['t1'] },
      facts: { type: 'object', description: 'fact name -> value' },
    },
    required: ['facts', 'nope'],
    additionalProperties: false,
  },
} as const;

const baseReq = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'gemini-test',
  maxOutputTokens: 100,
  messages: [{ role: 'user', content: 'go' }],
  ...over,
});

describe('GeminiProvider request mapping', () => {
  it('authenticates via header, never the URL, and declares tools in Gemini shape', async () => {
    const seen: Seen[] = [];
    const p = new GeminiProvider({ apiKey: 'SECRET-KEY', fetchImpl: fakeFetch([ok([{ text: 'hi' }])], seen) });
    await p.complete(baseReq({ tools: [EVALUATE_TOOL] }));
    const s = seen[0] as Seen;
    assert.ok(!s.url.includes('SECRET-KEY') && !s.url.includes('key='));
    assert.equal(s.headers['x-goog-api-key'], 'SECRET-KEY');
    const decl = (s.body['tools'] as { functionDeclarations: Record<string, unknown>[] }[])[0]?.functionDeclarations[0] as {
      name: string;
      parameters: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
    };
    assert.equal(decl.name, 'evaluate_decision_tree');
    // free-form object became a string; additionalProperties dropped; `required` filtered to declared properties
    assert.equal(decl.parameters.properties['facts']?.['type'], 'string');
    assert.match(String(decl.parameters.properties['facts']?.['description']), /JSON-encoded object string/);
    assert.deepEqual(decl.parameters.properties['tree_id'], { type: 'string', enum: ['t1'] });
    assert.deepEqual(decl.parameters.required, ['facts']);
    assert.ok(!JSON.stringify(s.body).includes('additionalProperties'));
  });

  it('omits `parameters` for a parameterless tool and omits `tools` when none are given', async () => {
    const seen: Seen[] = [];
    const p = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([ok([{ text: 'a' }]), ok([{ text: 'b' }])], seen) });
    await p.complete(baseReq({ tools: [{ name: 'ping', description: 'd', inputSchema: { type: 'object', properties: {} } }] }));
    await p.complete(baseReq());
    const decl = (seen[0]?.body['tools'] as { functionDeclarations: Record<string, unknown>[] }[])[0]?.functionDeclarations[0];
    assert.ok(decl !== undefined && !('parameters' in decl));
    assert.equal(seen[1]?.body['tools'], undefined);
  });

  it('forwards thinkingBudget only when configured', async () => {
    const seen: Seen[] = [];
    const p = new GeminiProvider({ apiKey: 'k', thinkingBudget: 0, fetchImpl: fakeFetch([ok([{ text: 'a' }])], seen) });
    await p.complete(baseReq());
    assert.deepEqual((seen[0]?.body['generationConfig'] as Record<string, unknown>)['thinkingConfig'], { thinkingBudget: 0 });
    const seen2: Seen[] = [];
    await new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([ok([{ text: 'a' }])], seen2) }).complete(baseReq());
    assert.equal((seen2[0]?.body['generationConfig'] as Record<string, unknown>)['thinkingConfig'], undefined);
  });

  it('rejects tool schemas that cannot be declared faithfully instead of silently weakening them', async () => {
    const p = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([], []) });
    const bad = (inputSchema: Record<string, unknown>) => p.complete(baseReq({ tools: [{ name: 't', description: 'd', inputSchema }] }));
    await assert.rejects(bad({ type: 'object', properties: { a: { $ref: '#/x' } } }), /unsupported keyword "\$ref"/);
    await assert.rejects(bad({ type: 'object', properties: { a: { allOf: [] } } }), /unsupported keyword "allOf"/);
    await assert.rejects(bad({ type: 'object', properties: { a: { type: 'integer', enum: [1, 2] } } }), /only strings/);
    await assert.rejects(bad({ type: 'object', properties: { a: { type: 'array' } } }), /no "items"/);
    await assert.rejects(bad({ type: 'object', properties: { a: { type: 'wat' } } }), /unsupported type/);
  });

  it('maps nullable type arrays and oneOf', async () => {
    const seen: Seen[] = [];
    const p = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([ok([{ text: 'x' }])], seen) });
    await p.complete(
      baseReq({
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: {
              type: 'object',
              properties: { a: { type: ['string', 'null'] }, b: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
            },
          },
        ],
      }),
    );
    const params = (seen[0]?.body['tools'] as { functionDeclarations: { parameters: { properties: Record<string, unknown> } }[] }[])[0]
      ?.functionDeclarations[0]?.parameters;
    assert.deepEqual(params?.properties['a'], { nullable: true, type: 'string' });
    assert.deepEqual(params?.properties['b'], { anyOf: [{ type: 'string' }, { type: 'number' }] });
  });
});

describe('GeminiProvider response mapping', () => {
  it('returns tool_use with synthesized unique ids, decoded free-form args and the thought signature', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        [
          ok([
            { text: 'thinking out loud', thought: true },
            { text: 'checking' },
            {
              functionCall: { name: 'evaluate_decision_tree', args: { tree_id: 't1', facts: '{"a":1,"b":"x"}' } },
              thoughtSignature: 'SIG1',
            },
            { functionCall: { name: 'evaluate_decision_tree', args: { facts: { already: 'object' } } } },
          ]),
        ],
        [],
      ),
    });
    const r = await p.complete(baseReq({ tools: [EVALUATE_TOOL] }));
    assert.equal(r.finishReason, 'tool_use');
    assert.equal(r.text, 'checking'); // thought part excluded
    assert.equal(r.toolCalls?.length, 2);
    assert.notEqual(r.toolCalls?.[0]?.id, r.toolCalls?.[1]?.id);
    assert.deepEqual(r.toolCalls?.[0]?.input, { tree_id: 't1', facts: { a: 1, b: 'x' } });
    assert.equal(r.toolCalls?.[0]?.providerState, 'SIG1');
    assert.equal(r.toolCalls?.[1]?.providerState, undefined);
    assert.deepEqual(r.toolCalls?.[1]?.input, { facts: { already: 'object' } });
  });

  it('leaves undecodable free-form values exactly as the model sent them (the executor must see them)', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        [
          ok([
            { functionCall: { name: 'evaluate_decision_tree', args: { facts: 'not json' } } },
            { functionCall: { name: 'evaluate_decision_tree', args: { facts: '[1,2]' } } },
          ]),
        ],
        [],
      ),
    });
    const r = await p.complete(baseReq({ tools: [EVALUATE_TOOL] }));
    assert.equal(r.toolCalls?.[0]?.input['facts'], 'not json');
    assert.equal(r.toolCalls?.[1]?.input['facts'], '[1,2]');
  });

  it('counts thinking and tool-use prompt tokens so cost and budgets are not understated', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        [
          ok([{ text: 'a' }], 'STOP', {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 30,
            toolUsePromptTokenCount: 5,
          }),
        ],
        [],
      ),
    });
    const r = await p.complete(baseReq());
    assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 34 });
  });

  it('refuses a response with no usageMetadata rather than reporting zero tokens', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }] } }], []),
    });
    await assert.rejects(p.complete(baseReq()), /no usageMetadata/);
  });

  it('maps finish reasons; a blocked prompt is content_filter; no candidates and no block is an error', async () => {
    const run = async (r: { body: unknown }) => new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([r], []) }).complete(baseReq());
    assert.equal((await run(ok([{ text: 'a' }], 'MAX_TOKENS'))).finishReason, 'length');
    assert.equal((await run(ok([{ text: 'a' }], 'SAFETY'))).finishReason, 'content_filter');
    assert.equal((await run(ok([{ text: 'a' }], 'MALFORMED_FUNCTION_CALL'))).finishReason, 'error');
    assert.equal((await run({ body: { candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: usage } })).text, '');
    const blocked = await run({ body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: usage } });
    assert.equal(blocked.finishReason, 'content_filter');
    await assert.rejects(run({ body: { usageMetadata: usage } }), /no candidates/);
  });

  it('never echoes the API key from an error body', async () => {
    const p = new GeminiProvider({
      apiKey: 'SECRET-KEY',
      fetchImpl: fakeFetch([{ status: 400, body: { error: { message: 'API key SECRET-KEY not valid' } } }], []),
    });
    await assert.rejects(p.complete(baseReq()), (e: Error) => /400/.test(e.message) && !e.message.includes('SECRET-KEY'));
  });
});

describe('toGeminiContents', () => {
  const call = (id: string, name = 'evaluate_decision_tree', providerState?: string) => ({
    id,
    name,
    input: { facts: { a: 1 } },
    ...(providerState !== undefined ? { providerState } : {}),
  });

  it('echoes calls with their signature, matches results by name, merges parallel results, flags errors', () => {
    const wire = toGeminiContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'calling', toolCalls: [call('gemini_call_1', 'a', 'SIG'), call('gemini_call_2', 'b')] },
      { role: 'tool', toolCallId: 'gemini_call_1', content: '{"ok":1}' },
      { role: 'tool', toolCallId: 'gemini_call_2', content: 'boom', isError: true },
      { role: 'user', content: 'next' },
    ]);
    assert.equal(wire.length, 4);
    assert.equal(wire[1]?.role, 'model');
    const modelParts = wire[1]?.parts as Record<string, unknown>[];
    assert.deepEqual(modelParts[0], { text: 'calling' });
    assert.equal(modelParts[1]?.['thoughtSignature'], 'SIG');
    assert.equal(modelParts[2]?.['thoughtSignature'], undefined);
    assert.deepEqual(wire[2], {
      role: 'user',
      parts: [
        { functionResponse: { name: 'a', response: { output: '{"ok":1}' } } },
        { functionResponse: { name: 'b', response: { error: 'boom' } } },
      ],
    });
    assert.deepEqual(wire[3], { role: 'user', parts: [{ text: 'next' }] });
  });

  it('keeps API-assigned ids on the wire but never leaks synthesized ones', () => {
    const wire = toGeminiContents([
      { role: 'assistant', content: '', toolCalls: [call('api-id-9', 't'), call('gemini_call_3', 't')] },
      { role: 'tool', toolCallId: 'api-id-9', content: 'x' },
      { role: 'tool', toolCallId: 'gemini_call_3', content: 'y' },
    ]);
    const calls = wire[0]?.parts as { functionCall: Record<string, unknown> }[];
    assert.equal(calls[0]?.functionCall['id'], 'api-id-9');
    assert.ok(!('id' in (calls[1]?.functionCall ?? {})));
    const res = wire[1]?.parts as { functionResponse: Record<string, unknown> }[];
    assert.equal(res[0]?.functionResponse['id'], 'api-id-9');
    assert.ok(!('id' in (res[1]?.functionResponse ?? {})));
  });

  it('fails closed on a tool result whose call id was never issued', () => {
    assert.throws(
      () =>
        toGeminiContents([
          { role: 'user', content: 'q' },
          { role: 'tool', toolCallId: 'forged', content: 'x' },
        ]),
      /unknown tool call id "forged"/,
    );
    assert.throws(() => toGeminiContents([{ role: 'tool', content: 'x' }]), /unknown tool call id/);
  });
});

describe('restoreFreeform', () => {
  it('does not pollute prototypes when the model sends __proto__-shaped JSON', () => {
    const schema = { type: 'object', properties: { facts: { type: 'object' } } };
    const out = restoreFreeform({ facts: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' }, schema) as {
      facts: Record<string, unknown>;
    };
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.getPrototypeOf(out.facts), Object.prototype);
  });

  it('recurses through arrays of objects', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { f: { type: 'object' } } } } },
    };
    const out = restoreFreeform({ items: [{ f: '{"x":1}' }, { f: '{"y":2}' }] }, schema);
    assert.deepEqual(out, { items: [{ f: { x: 1 } }, { f: { y: 2 } }] });
  });
});

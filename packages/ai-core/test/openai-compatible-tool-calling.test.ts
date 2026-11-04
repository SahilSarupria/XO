import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AzureOpenAiProvider, OllamaProvider, OpenAiProvider, type ProviderRequest } from '../src/index.js';

const tools = [{ name: 'evaluate', description: 'run it', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }];
const req = (messages: ProviderRequest['messages']): ProviderRequest => ({ model: 'm', maxOutputTokens: 50, messages, tools });

function fake(responses: unknown[], seen: Record<string, unknown>[]): typeof fetch {
  let i = 0;
  return (async (_u: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    const body = responses[i++];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
}
const oa = (message: unknown, finish = 'tool_calls') => ({
  choices: [{ message, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  model: 'gpt-x',
});
const call = (args: string, id = 'call_1') => ({ id, type: 'function', function: { name: 'evaluate', arguments: args } });

describe('OpenAI tool calling', () => {
  it('sends tool definitions and parses tool calls (JSON-string arguments)', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([oa({ content: null, tool_calls: [call('{"a":1}')] })], seen) });
    const r = await p.complete(req([{ role: 'user', content: 'go' }]));
    assert.equal(r.finishReason, 'tool_use');
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'evaluate', input: { a: 1 } }]);
    assert.deepEqual((seen[0]!['tools'] as { function: { name: string } }[])[0]!.function.name, 'evaluate');
    assert.equal(p.describeCapabilities().supportsToolCalling, true);
  });
  it('echoes assistant tool calls and tool results with matching ids on the next turn', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([oa({ content: 'done' }, 'stop')], seen) });
    await p.complete(
      req([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'evaluate', input: { a: 1 } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
      ]),
    );
    const m = seen[0]!['messages'] as Record<string, unknown>[];
    assert.equal(m[1]!['content'], null);
    assert.equal((m[1]!['tool_calls'] as { id: string; function: { arguments: string } }[])[0]!.function.arguments, '{"a":1}');
    assert.equal(m[2]!['tool_call_id'], 'call_1');
  });
  it('rejects a tool result that answers a call no assistant message made (never sent)', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([], seen) });
    await assert.rejects(p.complete(req([{ role: 'tool', content: 'x', toolCallId: 'nope' }])), /unknown tool call/);
    assert.equal(seen.length, 0);
  });
  it('fails closed on malformed or non-object arguments instead of calling the tool with {}', async () => {
    for (const bad of ['{"a":', '[1,2]', '"str"', '42']) {
      const p = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([oa({ content: null, tool_calls: [call(bad)] })], []) });
      await assert.rejects(p.complete(req([{ role: 'user', content: 'go' }])), /not valid JSON|not a JSON object/, bad);
    }
  });
  it('refuses tool calls that arrive on a truncated (length) reply', async () => {
    const p = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([oa({ content: null, tool_calls: [call('{"a":')] }, 'length')], []) });
    await assert.rejects(p.complete(req([{ role: 'user', content: 'go' }])), /not valid JSON|refusing to run/);
    const p2 = new OpenAiProvider({ apiKey: 'k', fetchImpl: fake([oa({ content: null, tool_calls: [call('{"a":1}')] }, 'length')], []) });
    await assert.rejects(p2.complete(req([{ role: 'user', content: 'go' }])), /refusing to run/);
  });
  it('does not treat __proto__ keys in arguments as anything special', async () => {
    const p = new OpenAiProvider({
      apiKey: 'k',
      fetchImpl: fake([oa({ content: null, tool_calls: [call('{"__proto__":{"x":1},"a":1}')] })], []),
    });
    const r = await p.complete(req([{ role: 'user', content: 'go' }]));
    assert.equal(({} as Record<string, unknown>)['x'], undefined);
    assert.equal((r.toolCalls![0]!.input as Record<string, unknown>)['a'], 1);
  });
});

describe('Azure OpenAI tool calling', () => {
  it('uses the same wire shape and parses tool calls', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new AzureOpenAiProvider({
      apiKey: 'k',
      endpoint: 'https://x.openai.azure.com',
      fetchImpl: fake([oa({ content: null, tool_calls: [call('{"a":2}')] })], seen),
    });
    const r = await p.complete(req([{ role: 'user', content: 'go' }]));
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'evaluate', input: { a: 2 } }]);
    assert.ok(seen[0]!['tools']);
  });
});

describe('Ollama tool calling', () => {
  const ol = (message: unknown, done = 'stop') => ({ message, done_reason: done, prompt_eval_count: 7, eval_count: 3 });
  it('parses object-valued arguments and synthesizes ids (Ollama gives none)', async () => {
    const p = new OllamaProvider({
      fetchImpl: fake([ol({ content: '', tool_calls: [{ function: { name: 'evaluate', arguments: { a: 3 } } }] })], []),
    });
    const r = await p.complete(req([{ role: 'user', content: 'go' }]));
    assert.equal(r.finishReason, 'tool_use');
    assert.equal(r.toolCalls![0]!.name, 'evaluate');
    assert.deepEqual(r.toolCalls![0]!.input, { a: 3 });
    assert.ok(r.toolCalls![0]!.id.length > 0);
  });
  it('sends tool results by tool name with object arguments echoed', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new OllamaProvider({ fetchImpl: fake([ol({ content: 'ok' })], seen) });
    await p.complete(
      req([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'ollama_call_0', name: 'evaluate', input: { a: 3 } }] },
        { role: 'tool', content: 'result', toolCallId: 'ollama_call_0' },
      ]),
    );
    const m = seen[0]!['messages'] as Record<string, unknown>[];
    assert.deepEqual((m[1]!['tool_calls'] as { function: { arguments: unknown } }[])[0]!.function.arguments, { a: 3 });
    assert.equal(m[2]!['tool_name'], 'evaluate');
  });
  it('refuses tool calls on a truncated reply', async () => {
    const p = new OllamaProvider({
      fetchImpl: fake([ol({ content: '', tool_calls: [{ function: { name: 'evaluate', arguments: { a: 1 } } }] }, 'length')], []),
    });
    await assert.rejects(p.complete(req([{ role: 'user', content: 'go' }])), /refusing to run/);
  });
});

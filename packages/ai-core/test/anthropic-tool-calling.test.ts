import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnthropicProvider, toAnthropicMessages, type ProviderRequest } from '../src/index.js';

function fakeFetch(responses: unknown[], seen: Record<string, unknown>[]): typeof fetch {
  let i = 0;
  return (async (_url: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    const body = responses[i++];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
}

describe('AnthropicProvider tool calling', () => {
  it('sends tool definitions and parses tool_use blocks', async () => {
    const seen: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        [
          {
            content: [
              { type: 'text', text: 'checking' },
              { type: 'tool_use', id: 'tu_1', name: 'evaluate', input: { a: 1 } },
            ],
            usage: { input_tokens: 5, output_tokens: 7 },
            stop_reason: 'tool_use',
          },
        ],
        seen,
      ),
    });
    const req: ProviderRequest = {
      model: 'm',
      maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'evaluate', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    };
    const res = await provider.complete(req);
    assert.equal(res.finishReason, 'tool_use');
    assert.deepEqual(res.toolCalls, [{ id: 'tu_1', name: 'evaluate', input: { a: 1 } }]);
    assert.equal(res.text, 'checking');
    const sent = seen[0] as { tools: { name: string; input_schema: unknown }[] };
    assert.equal(sent.tools[0]?.name, 'evaluate');
    assert.deepEqual(sent.tools[0]?.input_schema, { type: 'object', properties: {} });
  });

  it('merges parallel tool results into one user message and echoes tool_use blocks', () => {
    const wire = toAnthropicMessages([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [
          { id: 'a', name: 't', input: { x: 1 } },
          { id: 'b', name: 't', input: { x: 2 } },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: '1' },
      { role: 'tool', toolCallId: 'b', content: 'boom', isError: true },
    ]);
    assert.equal(wire.length, 3);
    const assistant = wire[1]!.content as Record<string, unknown>[];
    assert.deepEqual(
      assistant.map((b) => b['type']),
      ['text', 'tool_use', 'tool_use'],
    );
    const results = wire[2]!.content as Record<string, unknown>[];
    assert.equal(wire[2]!.role, 'user');
    assert.deepEqual(
      results.map((b) => b['tool_use_id']),
      ['a', 'b'],
    );
    assert.equal(results[1]!['is_error'], true);
  });

  it('other providers reject tool-bearing requests instead of silently dropping tools', async () => {
    const { OpenAiProvider } = await import('../src/index.js');
    const p = new OpenAiProvider({
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      p.complete({
        model: 'm',
        maxOutputTokens: 10,
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 't', description: 'd', inputSchema: {} }],
      }),
      /does not implement tool calling/,
    );
  });
});

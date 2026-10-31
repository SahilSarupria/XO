import { AiError, ErrorCode } from '@xo/errors';
import type { ProviderMessage, ProviderRequest, ProviderToolCall } from '../provider-types.js';

/** Shared by the OpenAI-compatible providers (OpenAI, Azure OpenAI) and, with `argsAsObject`, Ollama. */

export interface WireToolCall {
  readonly id?: string;
  readonly type?: 'function';
  readonly function: { readonly name: string; readonly arguments: string | Record<string, unknown> };
}

const fail = (m: string): never => {
  throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, m);
};

export function toWireTools(request: ProviderRequest): unknown[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Maps provider-neutral messages to the OpenAI chat wire format. A `tool` message must answer a call made by an earlier
 * assistant message in this same request; anything else is rejected rather than sent (fail closed).
 */
export function toWireMessages(messages: readonly ProviderMessage[], opts: { argsAsObject?: boolean } = {}): unknown[] {
  const known = new Map<string, string>(); // call id -> tool name
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      for (const c of m.toolCalls) known.set(c.id, c.name);
      out.push({
        role: 'assistant',
        content: m.content === '' ? null : m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: opts.argsAsObject === true ? c.input : JSON.stringify(c.input) },
        })),
      });
    } else if (m.role === 'tool') {
      const name = m.toolCallId === undefined ? undefined : known.get(m.toolCallId);
      if (m.toolCallId === undefined || name === undefined) fail(`tool message answers unknown tool call "${String(m.toolCallId)}"`);
      out.push(
        opts.argsAsObject === true
          ? { role: 'tool', tool_name: name, content: m.isError === true ? `ERROR: ${m.content}` : m.content }
          : { role: 'tool', tool_call_id: m.toolCallId, content: m.isError === true ? `ERROR: ${m.content}` : m.content },
      );
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Parses tool calls from a response. Arguments that are not a JSON object are an error, never an empty object. */
export function fromWireToolCalls(calls: readonly WireToolCall[] | undefined, idPrefix: string): ProviderToolCall[] {
  return (calls ?? []).map((c, i) => {
    const raw = c.function.arguments;
    let input: unknown = raw;
    if (typeof raw === 'string') {
      try {
        input = raw.trim() === '' ? {} : JSON.parse(raw);
      } catch {
        return fail(`model returned tool call "${c.function.name}" with arguments that are not valid JSON`);
      }
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return fail(`model returned tool call "${c.function.name}" with arguments that are not a JSON object`);
    return {
      id: c.id !== undefined && c.id !== '' ? c.id : `${idPrefix}_${i}`,
      name: c.function.name,
      input: input as Record<string, unknown>,
    };
  });
}

import type { ModelProvider, ProviderMessage, ProviderToolCall, ProviderToolDefinition } from '@xo/ai-core';

export interface AgentOptions {
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools?: readonly ProviderToolDefinition[];
  readonly executeTool?: (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) => { isError: boolean; content: string } | Promise<{ isError: boolean; content: string }>;
  readonly maxOutputTokens?: number;
  readonly maxTurns?: number;
  readonly temperature?: number;
  /** Hard ceiling on input+output tokens across the whole loop. Checked before every provider call; never exceeded by starting a new call. */
  readonly maxTotalTokens?: number;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
  readonly result: string;
}

export interface AgentRun {
  readonly text: string;
  readonly turns: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** True if the loop stopped (turn limit or budget) while the model was still asking for tools. */
  readonly truncated: boolean;
  readonly stoppedBy?: 'max_turns' | 'token_budget';
}

/**
 * A minimal tool-use loop: call the model; if it asks for tools, run them and
 * feed the results back; stop when it answers in plain text. Every tool call
 * is recorded so an evaluation can tell *whether the model used the XO*, not
 * just whether it got the answer right.
 */
export async function runAgent(provider: ModelProvider, userMessage: string, opts: AgentOptions): Promise<AgentRun> {
  const messages: ProviderMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const records: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const maxTurns = opts.maxTurns ?? 8;
  const tools = opts.tools !== undefined && opts.tools.length > 0 ? opts.tools : undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens >= opts.maxTotalTokens) {
      return { text: '', turns: turn - 1, toolCalls: records, usage, truncated: true, stoppedBy: 'token_budget' };
    }
    const res = await provider.complete({
      model: opts.model,
      messages,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(tools !== undefined ? { tools } : {}),
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;

    const calls: readonly ProviderToolCall[] = res.toolCalls ?? [];
    if (res.finishReason !== 'tool_use' || calls.length === 0) {
      return { text: res.text, turns: turn, toolCalls: records, usage, truncated: false };
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: calls });
    for (const call of calls) {
      const out =
        opts.executeTool !== undefined
          ? await opts.executeTool(call.name, call.input)
          : { isError: true, content: 'no tool executor configured' };
      records.push({ name: call.name, input: call.input, isError: out.isError, result: out.content });
      messages.push({ role: 'tool', toolCallId: call.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
    }
  }
  return { text: '', turns: maxTurns, toolCalls: records, usage, truncated: true, stoppedBy: 'max_turns' };
}

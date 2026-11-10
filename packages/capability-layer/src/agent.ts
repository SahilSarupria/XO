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
  /**
   * Whole-loop wall-clock cap in milliseconds, covering every model call and tool execution. Checked before each call and enforced DURING a call: when it
   * expires the loop returns `stoppedBy: 'wall_clock'` without waiting for the provider, and a result that arrives later is ignored. The abandoned provider call
   * is not cancelled (the provider interface has no cancel), so it may still finish and be billed; a tool already running is not interrupted either.
   */
  readonly maxWallClockMs?: number;
  /** Time source in ms, for tests. Default `Date.now`. */
  readonly clock?: () => number;
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
  readonly stoppedBy?: 'max_turns' | 'token_budget' | 'wall_clock';
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

  const now = opts.clock ?? Date.now;
  const deadline = opts.maxWallClockMs !== undefined ? now() + opts.maxWallClockMs : undefined;
  const expired = (): boolean => deadline !== undefined && now() >= deadline;
  const stopped = (turn: number): AgentRun => ({
    text: '',
    turns: turn - 1,
    toolCalls: records,
    usage,
    truncated: true,
    stoppedBy: 'wall_clock',
  });
  /** Resolves to `undefined` when the deadline passes first. */
  const within = async <T>(p: Promise<T>): Promise<T | undefined> => {
    if (deadline === undefined) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - now()));
    });
    try {
      return await Promise.race([p, limit]);
    } finally {
      clearTimeout(timer);
      p.catch(() => undefined); // an abandoned call that later fails must not become an unhandled rejection
    }
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (expired()) return stopped(turn);
    if (opts.maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens >= opts.maxTotalTokens) {
      return { text: '', turns: turn - 1, toolCalls: records, usage, truncated: true, stoppedBy: 'token_budget' };
    }
    const res = await within(
      provider.complete({
        model: opts.model,
        messages,
        maxOutputTokens: opts.maxOutputTokens ?? 1024,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(tools !== undefined ? { tools } : {}),
      }),
    );
    if (res === undefined) return stopped(turn);
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;

    const calls: readonly ProviderToolCall[] = res.toolCalls ?? [];
    if (res.finishReason !== 'tool_use' || calls.length === 0) {
      return { text: res.text, turns: turn, toolCalls: records, usage, truncated: false };
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: calls });
    for (const call of calls) {
      if (expired()) return stopped(turn + 1);
      const out =
        opts.executeTool !== undefined
          ? await within(Promise.resolve(opts.executeTool(call.name, call.input)))
          : { isError: true, content: 'no tool executor configured' };
      if (out === undefined) return stopped(turn + 1);
      records.push({ name: call.name, input: call.input, isError: out.isError, result: out.content });
      messages.push({ role: 'tool', toolCallId: call.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
    }
  }
  return { text: '', turns: maxTurns, toolCalls: records, usage, truncated: true, stoppedBy: 'max_turns' };
}

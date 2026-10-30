import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import type { FreightTask } from '../scenario/freight/generate.js';

/**
 * SELF-TEST ONLY. Two deterministic stand-ins used to prove the harness
 * plumbing end to end without an API key:
 *
 *   - with no tools offered it behaves like a rubber-stamp: approve what the
 *     claimant asks for (the failure mode the eval is built to expose);
 *   - with the decision-tree tool offered it extracts the stated facts
 *     perfectly, calls the tool once, and reports the tool's outcome.
 *
 * Its provider id starts with "sim" and the report banner keys off that, so
 * simulated numbers cannot be mistaken for measurements.
 */
export class SimulatedModel implements ModelProvider {
  readonly id = 'sim-self-test';
  calls = 0;
  private readonly byNarrative = new Map<string, FreightTask>();
  constructor(tasks: readonly FreightTask[]) {
    for (const t of tasks) this.byNarrative.set(t.narrative, t);
  }
  describeCapabilities() {
    return {
      providerId: this.id,
      models: ['sim-1'],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: true,
      maxContextTokens: 1_000_000,
    };
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    const user = [...req.messages].reverse().find((m) => m.role === 'user' && !m.toolCallId);
    const task = user === undefined ? undefined : this.byNarrative.get(user.content);
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
    const usage = { inputTokens: Math.ceil(req.messages.reduce((s, m) => s + m.content.length, 0) / 4), outputTokens: 40 };
    const hasTool = req.tools?.some((t) => t.name === 'evaluate_decision_tree') === true;

    if (hasTool && task !== undefined && lastTool === undefined) {
      return {
        text: '',
        usage,
        modelUsed: 'sim-1',
        finishReason: 'tool_use',
        toolCalls: [
          { id: `sim_${this.calls}`, name: 'evaluate_decision_tree', input: { tree_id: 'claim_adjudication', facts: task.statedFacts } },
        ],
      };
    }
    if (lastTool !== undefined && !lastTool.isError) {
      const o = (JSON.parse(lastTool.content) as { outcome: Record<string, unknown> }).outcome;
      return {
        text: JSON.stringify({
          decision: o['decision'],
          payout_usd: o['payout_usd'],
          escalation_target: o['escalation_target'],
          reason: 'per decision tree',
        }),
        usage,
        modelUsed: 'sim-1',
        finishReason: 'stop',
      };
    }
    const asked = /asking for \$([\d,]+)/.exec(user?.content ?? '')?.[1]?.replace(/,/g, '');
    return {
      text: JSON.stringify({ decision: 'approve', payout_usd: Number(asked ?? 0), escalation_target: null, reason: 'claim appears valid' }),
      usage,
      modelUsed: 'sim-1',
      finishReason: 'stop',
    };
  }
}

import { ConversationLayer, ScriptableTestProvider, jsonResponse, type ProviderResponse } from '@xo/ai-core';
import type { Evidence, Principal } from '../src/index.js';

export const principal: Principal = { identityId: 'ident_alice', workspaceId: 'ws_1', role: 'viewer' };

export const route = (
  r: Partial<{ route: string; confidence: number; standaloneQuery: string; needsClarification: boolean; clarifyingQuestion: string }> = {},
) => ({
  route: 'ask',
  confidence: 0.95,
  reasoning: 'test',
  standaloneQuery: 'status of project alpha',
  needsClarification: false,
  clarifyingQuestion: '',
  ...r,
});

export const askOut = (o: Partial<Record<string, unknown>> = {}) => ({
  answerable: true,
  answer: 'Project Alpha is delayed by customs clearance [E1].',
  confidence: 'high',
  confidenceReason: 'Two recent sources agree.',
  contradictions: [],
  gaps: [],
  followUps: [],
  ...o,
});

export const decideOut = (o: Partial<Record<string, unknown>> = {}) => ({
  summary: 'Alpha is late because of customs [E1].',
  problems: [{ description: 'Customs hold', evidenceIds: ['E1'] }],
  options: [
    {
      title: 'Expedite',
      description: 'Pay for expedited clearance',
      pros: ['fast'],
      cons: ['cost'],
      consequences: ['ships Friday'],
      dependencies: [],
      evidenceIds: ['E1'],
    },
    {
      title: 'Wait',
      description: 'Let it clear',
      pros: ['free'],
      cons: ['slow'],
      consequences: ['ships next week'],
      dependencies: [],
      evidenceIds: [],
    },
  ],
  recommendedOption: 'Expedite',
  recommendationRationale: 'The customer deadline is firm [E1].',
  risks: [{ description: 'Cost overrun', severity: 'medium' }],
  assumptions: ['Budget is available'],
  confidence: 'medium',
  confidenceReason: 'One source.',
  contradictions: [],
  gaps: [],
  ...o,
});

export const ev = (n: number, over: Partial<Evidence> = {}): Evidence => ({
  id: `doc-${n}`,
  sourceId: `src-${n}`,
  sourceName: `Source ${n}`,
  excerpt: `Project Alpha status update ${n}: shipment held at customs.`,
  asOf: '2026-10-30T00:00:00Z',
  ...over,
});

export const text = (t: string): ProviderResponse => ({
  text: t,
  usage: { inputTokens: 1, outputTokens: 1 },
  modelUsed: 'm',
  finishReason: 'stop',
});

const fast = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };

/** A real ConversationLayer over a scripted provider: replies are consumed in call order. */
export function scripted(...replies: (object | ProviderResponse)[]) {
  const provider = new ScriptableTestProvider(
    'p',
    replies.map((r) => ({
      kind: 'success' as const,
      response: 'usage' in r ? (r as ProviderResponse) : jsonResponse(r, { inputTokens: 10, outputTokens: 5 }, 'm'),
    })),
  );
  const model = new ConversationLayer({
    providers: [provider],
    retryOptions: fast,
    policy: { rules: [{ capability: '*', providerOrder: ['p'], modelByProvider: { p: 'm' } }] },
  });
  return { provider, model };
}

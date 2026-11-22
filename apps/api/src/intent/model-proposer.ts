import { buildEgressRequest, defineResponseSchema, defineTemplate, egressOf, filterIntent, type ModelProvider } from '@xo/ai-core';
import type { ModelChoice, WorkspaceSettings } from '../settings/workspace-settings.js';
import type { ProviderFactory } from '../chat/model-provider.js';

/**
 * UW-6 (ADR 0043, amended): the only way free text reaches a model to become a workflow proposal. The request is built by the UW-14
 * typed egress boundary from a fixed template and the person's text after the intent filter, so in `masked_hosted` a contracted
 * provider may receive it and the leak guard scans it before it leaves; in `strict_local` only a local model can. Nothing else from
 * the workspace (sources, cells, knowledge) is ever part of the request, and the answer has no authority: the route parses it as a
 * bounded proposal and composes it exactly like a person's structured goal.
 */
const SYSTEM = defineTemplate(
  'intent/propose-system',
  [
    'You turn a person’s request into a workflow proposal. Answer with one JSON object and nothing else.',
    'Fields: "text" (the goal in one sentence), "needs" (up to 20 short names of the things the workflow must do, in order),',
    'optionally "section" (the name of the procedure section the goal refers to) and "forEach" (the name of the list to repeat over).',
    'Do not add steps, approvals, recipients, amounts or instructions. If the request is unclear, return only "text".',
  ].join('\n'),
);

const SCHEMA = defineResponseSchema('intent/propose-schema', {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', maxLength: 2000 },
    needs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
    section: { type: 'string', maxLength: 200 },
    forEach: { type: 'string', maxLength: 200 },
  },
});

/** The workspace's selected models that may receive a typed request under the instance's residency (air-gapped: local only). */
export function typedModelChoice(
  settings: WorkspaceSettings,
  providerFor: ProviderFactory,
  localIds: ReadonlySet<string>,
): { readonly choice: ModelChoice; readonly provider: ModelProvider } | undefined {
  for (const choice of [settings.model.primary, settings.model.fallback]) {
    if (choice === null) continue;
    if (settings.airGapped && !localIds.has(choice.provider)) continue;
    const provider = providerFor(choice.provider);
    if (provider === undefined) continue;
    const egress = egressOf(provider);
    // Only a guarded provider qualifies: the factory guards every one it builds, so an unguarded one means a wiring fault.
    if (egress === undefined || !egress.typedAllowed) continue;
    return { choice, provider };
  }
  return undefined;
}

/** Asks the model for a proposal through the typed boundary. Throws the guard's refusal (residency or leak guard) unchanged. */
export async function proposeIntent(provider: ModelProvider, model: string, text: string, signal?: AbortSignal): Promise<string> {
  const request = buildEgressRequest({
    model,
    maxOutputTokens: 1200,
    temperature: 0,
    responseSchema: SCHEMA,
    messages: [
      { role: 'system', parts: [SYSTEM] },
      { role: 'user', parts: [filterIntent(text)] },
    ],
    ...(signal !== undefined ? { signal } : {}),
  });
  return (await provider.complete(request)).text;
}

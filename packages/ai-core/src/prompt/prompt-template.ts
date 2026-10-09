import type { ProviderMessage } from '../provider-types.js';
import type { CapabilityId } from '../capability-types.js';

/**
 * A versioned prompt: one capability may have several versions registered
 * over time (see prompt-registry.ts), and every `CapabilityResponseMeta`
 * carries which version actually served a given call — so a prompt change
 * is auditable in exactly the way a schema-version bump is auditable
 * elsewhere in this repo (`@xo/xoir`'s `versioning.ts` is the model this
 * follows).
 */
export interface PromptTemplate<TInput> {
  readonly capability: CapabilityId;
  readonly version: string;
  render(input: TInput, excerptText: string): readonly ProviderMessage[];
}

export function definePromptTemplate<TInput>(
  capability: CapabilityId,
  version: string,
  render: (input: TInput, excerptText: string) => readonly ProviderMessage[],
): PromptTemplate<TInput> {
  return { capability, version, render };
}

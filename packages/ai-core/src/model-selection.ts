import type { CapabilityId } from './capability-types.js';
import type { ProviderCapabilityDescriptor, ProviderId } from './provider-types.js';

export interface ModelSelectionRule {
  readonly capability: CapabilityId | '*'; // '*' applies to any capability with no more specific rule
  /** Preference order — the first eligible (registered + capable) provider is primary; the rest form the fallback chain, in order. */
  readonly providerOrder: readonly ProviderId[];
  readonly modelByProvider: Readonly<Record<string, string>>;
}

export interface ModelSelectionPolicy {
  readonly rules: readonly ModelSelectionRule[];
}

export interface SelectedCandidate {
  readonly providerId: ProviderId;
  readonly model: string;
}

function findRule(policy: ModelSelectionPolicy, capability: CapabilityId): ModelSelectionRule | undefined {
  return policy.rules.find((r) => r.capability === capability) ?? policy.rules.find((r) => r.capability === '*');
}

/**
 * Resolves the ordered candidate list `router.ts` walks through (primary
 * first, then fallbacks) for one capability call — a real, configurable
 * policy, not a hardcoded provider choice. A provider is excluded
 * entirely (not just deprioritized) if it isn't registered at all, or if
 * `requireStructuredOutput` is set and its `ProviderCapabilityDescriptor`
 * says it can't do structured output — see provider-types.ts's doc
 * comment on that tradeoff.
 */
export function selectCandidates(
  policy: ModelSelectionPolicy,
  capability: CapabilityId,
  availableProviders: ReadonlySet<ProviderId>,
  descriptors: ReadonlyMap<ProviderId, ProviderCapabilityDescriptor>,
  requireStructuredOutput: boolean,
): readonly SelectedCandidate[] {
  const rule = findRule(policy, capability);
  if (!rule) return [];

  const candidates: SelectedCandidate[] = [];
  for (const providerId of rule.providerOrder) {
    if (!availableProviders.has(providerId)) continue;
    const descriptor = descriptors.get(providerId);
    if (requireStructuredOutput && descriptor && !descriptor.supportsStructuredOutput) continue;
    const model = rule.modelByProvider[providerId];
    if (model === undefined) continue;
    candidates.push({ providerId, model });
  }
  return candidates;
}

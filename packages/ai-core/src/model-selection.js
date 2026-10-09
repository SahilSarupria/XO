function findRule(policy, capability) {
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
export function selectCandidates(policy, capability, availableProviders, descriptors, requireStructuredOutput) {
    const rule = findRule(policy, capability);
    if (!rule)
        return [];
    const candidates = [];
    for (const providerId of rule.providerOrder) {
        if (!availableProviders.has(providerId))
            continue;
        const descriptor = descriptors.get(providerId);
        if (requireStructuredOutput && descriptor && !descriptor.supportsStructuredOutput)
            continue;
        const model = rule.modelByProvider[providerId];
        if (model === undefined)
            continue;
        candidates.push({ providerId, model });
    }
    return candidates;
}
//# sourceMappingURL=model-selection.js.map
const COMPONENT_KINDS = [
    'knowledge_graph',
    'long_term_memory_graph',
    'decision_trees',
    'reasoning_traces',
    'case_library',
    'prompt_strategies',
    'lora',
    'finetune',
    'safety_rules',
    'benchmark_suite',
];
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isContentHash(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function isComponentEntry(value) {
    return isRecord(value) && typeof value.path === 'string' && isContentHash(value.hash) && typeof value.required === 'boolean';
}
function isCompatibilityDeclaration(value) {
    if (!isRecord(value) || !Array.isArray(value.modelFamilies))
        return false;
    if (value.fallbackPolicy !== 'degrade_gracefully' && value.fallbackPolicy !== 'reject')
        return false;
    return value.modelFamilies.every((mf) => isRecord(mf) && typeof mf.family === 'string' && Array.isArray(mf.minCapability) && Array.isArray(mf.consumes));
}
const EXECUTION_MODES = ['deterministic_rule', 'model'];
const INPUT_PROPERTY_TYPES = ['string', 'number', 'boolean'];
function isCapabilityInputSchema(value) {
    if (!isRecord(value))
        return false;
    if (value.type !== 'object')
        return false;
    if (!isRecord(value.properties))
        return false;
    if (!Object.values(value.properties).every((p) => isRecord(p) && INPUT_PROPERTY_TYPES.includes(p.type)))
        return false;
    if (!Array.isArray(value.required) || !value.required.every((r) => typeof r === 'string'))
        return false;
    return true;
}
/**
 * `execution` is OPTIONAL on `CapabilityDeclaration` (R1) — this
 * validator is only reached when a declaration actually has one, so a
 * `.xo` package compiled before this field existed still validates
 * exactly as it did before. When present, though, it's validated
 * strictly: a malformed `execution` block is a package integrity
 * problem (a runtime that trusted it could execute against a wrong or
 * absent schema), so it's rejected here rather than being passed through
 * for a runtime to discover the hard way.
 */
function isCapabilityExecutionDeclaration(value) {
    if (!isRecord(value))
        return false;
    if (!EXECUTION_MODES.includes(value.mode))
        return false;
    if (value.bindingId !== undefined && typeof value.bindingId !== 'string')
        return false;
    if (value.contractId !== undefined && typeof value.contractId !== 'string')
        return false;
    if (value.inputSchema !== undefined && !isCapabilityInputSchema(value.inputSchema))
        return false;
    if (value.requiredPermissionIds !== undefined && (!Array.isArray(value.requiredPermissionIds) || !value.requiredPermissionIds.every((p) => typeof p === 'string')))
        return false;
    return true;
}
function isCapabilityDeclaration(value) {
    if (!isRecord(value))
        return false;
    if (typeof value.id !== 'string' || value.id.length === 0)
        return false;
    if (typeof value.name !== 'string' || value.name.length === 0)
        return false;
    if (typeof value.description !== 'string' || value.description.length === 0)
        return false;
    if (!Array.isArray(value.providerCompatibility) || !value.providerCompatibility.every((f) => typeof f === 'string'))
        return false;
    if (!Array.isArray(value.requiredComponents) || !value.requiredComponents.every((k) => COMPONENT_KINDS.includes(k)))
        return false;
    if (!isRecord(value.estimatedCost) || typeof value.estimatedCost.currency !== 'string' || typeof value.estimatedCost.amount !== 'number')
        return false;
    if (typeof value.estimatedLatencyMs !== 'number')
        return false;
    if (!isRecord(value.confidence) || typeof value.confidence.score !== 'number')
        return false;
    if (!['self_reported', 'benchmark', 'expert_review'].includes(value.confidence.basis))
        return false;
    if (value.execution !== undefined && !isCapabilityExecutionDeclaration(value.execution))
        return false;
    return true;
}
const DEPENDENCY_KINDS = ['required', 'optional', 'peer'];
function isDependencyDeclaration(value) {
    if (!isRecord(value))
        return false;
    if (typeof value.name !== 'string' || value.name.length === 0)
        return false;
    if (typeof value.versionRange !== 'string' || value.versionRange.length === 0)
        return false;
    if (!DEPENDENCY_KINDS.includes(value.kind))
        return false;
    return true;
}
/**
 * A structural (not semantic) check that `value` has the shape of an
 * {@link XoManifest} — every field of the right type, present where
 * required. It does NOT check hash correctness, Merkle consistency, or
 * signature validity; those are `PackageValidator`'s job precisely because
 * they can fail independently of shape (a well-formed manifest can still
 * lie about its hashes). Used by the reader to reject obviously-malformed
 * JSON before it's ever handed to the rest of the SDK as a typed value.
 */
export function isXoManifest(value) {
    if (!isRecord(value))
        return false;
    if (typeof value.formatVersion !== 'string')
        return false;
    if (typeof value.name !== 'string' || value.name.length === 0)
        return false;
    if (typeof value.version !== 'string')
        return false;
    if (typeof value.creatorDid !== 'string' || value.creatorDid.length === 0)
        return false;
    if (!isCompatibilityDeclaration(value.compatibility))
        return false;
    if (!isRecord(value.components))
        return false;
    for (const [kind, entry] of Object.entries(value.components)) {
        if (!COMPONENT_KINDS.includes(kind))
            return false;
        if (!isComponentEntry(entry))
            return false;
    }
    if (value.capabilities !== undefined) {
        if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapabilityDeclaration))
            return false;
    }
    if (value.dependencies !== undefined) {
        if (!Array.isArray(value.dependencies) || !value.dependencies.every(isDependencyDeclaration))
            return false;
    }
    if (value.merkleRoot !== undefined && !isContentHash(value.merkleRoot))
        return false;
    if (value.signatures !== undefined) {
        if (!Array.isArray(value.signatures))
            return false;
        const rolesOk = value.signatures.every((s) => isRecord(s) && typeof s.signerDid === 'string' && ['creator', 'reviewer', 'co_signer'].includes(s.role) && typeof s.signature === 'string');
        if (!rolesOk)
            return false;
    }
    return true;
}
export function isXoMetadata(value) {
    return (isRecord(value) &&
        typeof value.domain === 'string' &&
        typeof value.description === 'string' &&
        Array.isArray(value.scope) &&
        Array.isArray(value.limitations) &&
        (value.tags === undefined || Array.isArray(value.tags)));
}
export { COMPONENT_KINDS };
//# sourceMappingURL=schema.js.map
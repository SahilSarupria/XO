export function allowDecision(input) {
    return Object.freeze({
        request: input.request,
        effect: 'allow',
        reason: input.reason,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        consentInvolved: input.consentInvolved ?? false,
        grantedScope: input.grantedScope,
        lifetime: input.lifetime,
        decidedAt: input.decidedAt,
        persistent: input.persistent ?? false,
    });
}
export function denyDecision(input) {
    return Object.freeze({
        request: input.request,
        effect: 'deny',
        reason: input.reason,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        consentInvolved: input.consentInvolved ?? false,
        decidedAt: input.decidedAt,
        persistent: false,
    });
}
export function promptDecision(input) {
    return Object.freeze({
        request: input.request,
        effect: 'prompt',
        reason: input.reason,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        consentInvolved: input.consentInvolved ?? false,
        decidedAt: input.decidedAt,
        persistent: false,
    });
}
//# sourceMappingURL=decision.js.map
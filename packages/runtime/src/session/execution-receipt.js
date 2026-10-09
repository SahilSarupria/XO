import { ReceiptId } from '../ids.js';
/**
 * Assembles the receipt for one planning attempt. Pulls
 * `packagesUsed`/`componentHashes` from the plan's `selected` candidate
 * (if any) resolved back against `registry` — never from the request or
 * the caller, so a receipt can't claim a package was used that wasn't
 * actually the one the negotiator selected.
 */
export function buildReceipt(params) {
    const { plan, registry, validationResults, executionDurationMs, environment, errors = [], now = () => new Date() } = params;
    const selectedMount = plan.selected ? registry.get(plan.selected.capability.packageName, plan.selected.capability.packageVersion) : undefined;
    return Object.freeze({
        receiptId: ReceiptId(`receipt_${plan.planId}_${now().getTime()}`),
        requestId: plan.requestId,
        planId: plan.planId,
        packagesUsed: selectedMount ? [{ name: selectedMount.name, version: selectedMount.version }] : [],
        componentHashes: selectedMount ? Object.entries(selectedMount.manifest.components).map(([kind, entry]) => ({ kind: kind, hash: entry.hash })) : [],
        capabilitiesInvoked: plan.selected ? [plan.selected.capability.declaration.id] : [],
        ...(environment?.provider !== undefined ? { provider: environment.provider } : {}),
        executionDurationMs,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
        validationResults,
        errors,
        createdAt: now().toISOString(),
    });
}
/**
 * Builds the receipt for a completed Stage 2 execution — same shape as
 * {@link buildReceipt}, but `tokenUsage`/`estimatedCost` come from the
 * real `StructuredResponse` the AI Capability Layer produced rather than
 * `buildReceipt`'s fixed `{0, 0}` placeholder, and `degraded` reflects
 * whatever `ExecutionPipeline` observed (budget trimming, `L0` fallback).
 */
export function buildExecutionReceipt(params) {
    const { plan, registry, response, validationResults, executionDurationMs, environment, errors = [], now = () => new Date() } = params;
    const selectedMount = plan.selected ? registry.get(plan.selected.capability.packageName, plan.selected.capability.packageVersion) : undefined;
    return Object.freeze({
        receiptId: ReceiptId(`receipt_${plan.planId}_${now().getTime()}`),
        requestId: plan.requestId,
        planId: plan.planId,
        packagesUsed: selectedMount ? [{ name: selectedMount.name, version: selectedMount.version }] : [],
        componentHashes: selectedMount ? Object.entries(selectedMount.manifest.components).map(([kind, entry]) => ({ kind: kind, hash: entry.hash })) : [],
        capabilitiesInvoked: [response.capabilityId],
        ...(environment?.provider !== undefined ? { provider: environment.provider } : {}),
        executionDurationMs,
        tokenUsage: response.usage,
        validationResults,
        errors,
        createdAt: now().toISOString(),
        ...(plan.selected ? { estimatedCost: plan.selected.capability.declaration.estimatedCost } : {}),
        degraded: response.degraded,
    });
}
/**
 * Builds a receipt for one `RuntimeCapabilityExecutor.execute()` call made
 * against a binding `registerResolvedCapabilityBinding` registered.
 * `packagesUsed`/`componentHashes` are always empty and `validationResults`
 * is always a trivial passing report — there is no package or component
 * validation involved in this path (the contract this execution traces
 * back to was validated, if at all, when its source package was mounted,
 * not at execution time) — never a fabricated validation result standing
 * in for one that didn't actually run.
 */
export function buildCapabilityAuthorityReceipt(params) {
    const { requestId, planId, capabilityId, contractId, bindingId, sourceXoirNodeIds, executionDurationMs, errors = [], now = () => new Date() } = params;
    return Object.freeze({
        receiptId: ReceiptId(`receipt_${planId}_${now().getTime()}`),
        requestId,
        planId,
        packagesUsed: [],
        componentHashes: [],
        capabilitiesInvoked: [capabilityId],
        executionDurationMs,
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
        validationResults: { valid: true, issues: [] },
        errors,
        createdAt: now().toISOString(),
        contractId,
        bindingId,
        sourceXoirNodeIds,
    });
}
//# sourceMappingURL=execution-receipt.js.map
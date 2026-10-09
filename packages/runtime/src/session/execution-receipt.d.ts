import type { CapabilityCostEstimate, ComponentKind, ContentHash } from '@xo/types';
import type { ValidationReport } from '@xo/package-sdk';
import type { ExecutionEnvironment } from '../execution/execution-request.js';
import type { ExecutionPlan } from '../execution/execution-plan.js';
import type { PackageRegistry } from '../registry/mounted-package.js';
import type { StructuredResponse, TokenUsage } from '../response/response-assembler.js';
import { ReceiptId, type PlanId, type RequestId } from '../ids.js';
export interface ExecutionReceiptPackageRecord {
    readonly name: string;
    readonly version: string;
}
export interface ExecutionReceiptComponentRecord {
    readonly kind: ComponentKind;
    readonly hash: ContentHash;
}
/**
 * An immutable record of one execution attempt. In Stage 1, "execution"
 * means the mount-verification + deterministic-planning pipeline itself
 * — there is no prompt assembly, retrieval, or provider call yet for a
 * receipt to describe, so `capabilitiesInvoked` names capabilities that
 * were *selected by planning*, not capabilities that were actually
 * exercised by a model. That distinction is preserved deliberately
 * rather than glossed over: a later runtime stage that adds real
 * execution should be able to tell Stage 1 receipts and its own apart by
 * this field's meaning, not just by which runtime stage produced them.
 */
export interface ExecutionReceipt {
    readonly receiptId: ReceiptId;
    readonly requestId: RequestId;
    readonly planId: PlanId;
    readonly packagesUsed: readonly ExecutionReceiptPackageRecord[];
    readonly componentHashes: readonly ExecutionReceiptComponentRecord[];
    readonly capabilitiesInvoked: readonly string[];
    readonly provider?: string;
    readonly executionDurationMs: number;
    readonly tokenUsage: TokenUsage;
    readonly validationResults: ValidationReport;
    readonly errors: readonly string[];
    readonly createdAt: string;
    /** Stage 2. Absent for a Stage 1 planning-only receipt (`buildReceipt`); present on a Stage 2 execution receipt (`buildExecutionReceipt`) — the executed capability's own `estimatedCost`, not a real provider-billed figure (`@xo/ai-core` is provisional and has no real billing data to report). */
    readonly estimatedCost?: CapabilityCostEstimate;
    /** Stage 2. `true` iff anything degraded before this receipt's response was produced (see `BudgetManager.fit`'s `degraded` flag, or an `L0` `degrade_gracefully` plan). Absent on a Stage 1 receipt. */
    readonly degraded?: boolean;
    /**
     * Capability-authority execution path only (`buildCapabilityAuthorityReceipt`,
     * below) — absent on every Stage 1/Stage 2 (manifest/AI-provider path)
     * receipt. The `@xo/capability-contract` contract id (== the source
     * XOIR capability node's id) this execution's `RuntimeCapabilityDeclaration`
     * was registered from — see `registerResolvedCapabilityBinding`.
     */
    readonly contractId?: string;
    /** Capability-authority execution path only — the `CapabilityBinding.id` (from `@xo/capability-contract`) whose evaluator actually ran. */
    readonly bindingId?: string;
    /**
     * Capability-authority execution path only — every XOIR node id this
     * execution's contract was built from (the capability node plus every
     * linked rule node — see `SemanticCapabilityContract.sourceXoirNodeIds`),
     * preserved verbatim so a receipt can be traced back through the
     * contract to the original compiled XOIR, and from there (via each
     * node's own `sourceRefs`) back to source document evidence — the full
     * chain §8 requires, reusing the existing provenance structures at
     * every step rather than inventing a parallel one.
     */
    readonly sourceXoirNodeIds?: readonly string[];
}
export interface BuildReceiptParams {
    readonly plan: ExecutionPlan;
    readonly registry: PackageRegistry;
    readonly validationResults: ValidationReport;
    readonly executionDurationMs: number;
    readonly environment?: ExecutionEnvironment;
    readonly errors?: readonly string[];
    readonly now?: () => Date;
}
/**
 * Assembles the receipt for one planning attempt. Pulls
 * `packagesUsed`/`componentHashes` from the plan's `selected` candidate
 * (if any) resolved back against `registry` — never from the request or
 * the caller, so a receipt can't claim a package was used that wasn't
 * actually the one the negotiator selected.
 */
export declare function buildReceipt(params: BuildReceiptParams): ExecutionReceipt;
export interface BuildExecutionReceiptParams {
    readonly plan: ExecutionPlan;
    readonly registry: PackageRegistry;
    readonly response: StructuredResponse;
    readonly validationResults: ValidationReport;
    readonly executionDurationMs: number;
    readonly environment?: ExecutionEnvironment;
    readonly errors?: readonly string[];
    readonly now?: () => Date;
}
/**
 * Builds the receipt for a completed Stage 2 execution — same shape as
 * {@link buildReceipt}, but `tokenUsage`/`estimatedCost` come from the
 * real `StructuredResponse` the AI Capability Layer produced rather than
 * `buildReceipt`'s fixed `{0, 0}` placeholder, and `degraded` reflects
 * whatever `ExecutionPipeline` observed (budget trimming, `L0` fallback).
 */
export declare function buildExecutionReceipt(params: BuildExecutionReceiptParams): ExecutionReceipt;
export interface BuildCapabilityAuthorityReceiptParams {
    readonly requestId: RequestId;
    readonly planId: PlanId;
    readonly capabilityId: string;
    readonly contractId: string;
    readonly bindingId: string;
    readonly sourceXoirNodeIds: readonly string[];
    readonly executionDurationMs: number;
    readonly errors?: readonly string[];
    readonly now?: () => Date;
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
export declare function buildCapabilityAuthorityReceipt(params: BuildCapabilityAuthorityReceiptParams): ExecutionReceipt;
//# sourceMappingURL=execution-receipt.d.ts.map
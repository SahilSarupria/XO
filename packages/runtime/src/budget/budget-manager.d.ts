import type { RetrievedSlice } from '../retrieval/retrieved-slice.js';
export interface BudgetFitResult {
    /** Slices that fit, in their *original* relative order (not priority order) — downstream context assembly shouldn't have to know this class reordered anything internally to decide. */
    readonly kept: readonly RetrievedSlice[];
    readonly dropped: readonly RetrievedSlice[];
    readonly totalEstimatedTokens: number;
    /** `true` iff anything was dropped — the signal `ExecutionPipeline` uses to mark a session/receipt as `degraded`. */
    readonly degraded: boolean;
}
/**
 * Implements Stage 2's "execution budgets" + "graceful degradation"
 * requirements: given more retrieved content than a request's token
 * budget allows, keeps the highest-priority slices and drops the rest,
 * deterministically, rather than failing the whole execution.
 * `safety_rules` is always kept — a budget too small to include safety
 * rules is a budget too small to execute at all, not a reason to run
 * without them.
 */
export declare class BudgetManager {
    fit(slices: readonly RetrievedSlice[], tokenBudget: number): BudgetFitResult;
}
//# sourceMappingURL=budget-manager.d.ts.map
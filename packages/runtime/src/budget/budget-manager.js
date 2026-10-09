/**
 * Lower drops first. `safety_rules` is never dropped by priority alone
 * (see {@link BudgetManager.fit}) regardless of where it'd otherwise
 * fall — everything else degrades before safety does.
 */
const COMPONENT_PRIORITY = {
    safety_rules: 0,
    decision_trees: 1,
    knowledge_graph: 2,
    case_library: 3,
    reasoning_traces: 4,
    prompt_strategies: 5,
    benchmark_suite: 6,
    long_term_memory_graph: 7,
    lora: 8,
    finetune: 9,
};
/**
 * Implements Stage 2's "execution budgets" + "graceful degradation"
 * requirements: given more retrieved content than a request's token
 * budget allows, keeps the highest-priority slices and drops the rest,
 * deterministically, rather than failing the whole execution.
 * `safety_rules` is always kept — a budget too small to include safety
 * rules is a budget too small to execute at all, not a reason to run
 * without them.
 */
export class BudgetManager {
    fit(slices, tokenBudget) {
        const sorted = [...slices].sort((a, b) => (COMPONENT_PRIORITY[a.componentKind] ?? 99) - (COMPONENT_PRIORITY[b.componentKind] ?? 99));
        const kept = [];
        const dropped = [];
        let total = 0;
        for (const slice of sorted) {
            const isSafetyRules = slice.componentKind === 'safety_rules';
            if (isSafetyRules || total + slice.estimatedTokens <= tokenBudget) {
                kept.push(slice);
                total += slice.estimatedTokens;
            }
            else {
                dropped.push(slice);
            }
        }
        const keptSet = new Set(kept);
        const keptInOriginalOrder = slices.filter((slice) => keptSet.has(slice));
        return { kept: keptInOriginalOrder, dropped, totalEstimatedTokens: total, degraded: dropped.length > 0 };
    }
}
//# sourceMappingURL=budget-manager.js.map
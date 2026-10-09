/** Stage 8's target shape: extractDecisionGraph(). Decision nodes, branch conditions, dependencies, escalation paths, risk thresholds, and fallbacks. */
export interface DecisionNode {
    readonly id: string;
    readonly question: string;
    readonly dependsOnDecisionIds: readonly string[];
}
export interface DecisionBranch {
    readonly decisionId: string;
    readonly condition: string;
    readonly outcome: string;
    readonly leadsToDecisionId?: string;
}
export interface EscalationPath {
    readonly triggerCondition: string;
    readonly escalateTo: string;
}
export interface RiskThreshold {
    readonly metric: string;
    readonly thresholdDescription: string;
    readonly aboveThresholdAction: string;
}
export interface Fallback {
    readonly whenDecisionFails: string;
    readonly fallbackAction: string;
}
export interface DecisionGraphExtractionInput {
    readonly focusQuestion?: string;
}
export interface DecisionGraphExtractionOutput {
    readonly decisions: readonly DecisionNode[];
    readonly branches: readonly DecisionBranch[];
    readonly escalationPaths: readonly EscalationPath[];
    readonly riskThresholds: readonly RiskThreshold[];
    readonly fallbacks: readonly Fallback[];
}
//# sourceMappingURL=decisions.d.ts.map
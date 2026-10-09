/** Stage 9's target shape: extractConstraints(). Jurisdiction, safety, regulatory, and business constraints, plus confidence boundaries. */
export type ConstraintKind = 'jurisdiction' | 'safety' | 'regulatory' | 'business';
export interface ExtractedConstraint {
    readonly kind: ConstraintKind;
    readonly rule: string;
    readonly severity: 'info' | 'warning' | 'blocking';
    readonly applicability: string;
}
export interface ConfidenceBoundary {
    readonly topic: string;
    readonly reason: string;
}
export interface ConstraintExtractionInput {
    readonly domainHint?: string;
}
export interface ConstraintExtractionOutput {
    readonly constraints: readonly ExtractedConstraint[];
    readonly confidenceBoundaries: readonly ConfidenceBoundary[];
}
//# sourceMappingURL=constraints.d.ts.map
import type { XoirGraph } from './graph.js';
import type { XoirEdgeId, XoirNodeId } from './ids.js';
export type ValidationIssueKind = 'dangling_edge_reference' | 'hash_mismatch' | 'missing_required_property' | 'unsupported_schema_version' | 'invalid_confidence_range' | 'invalid_provenance_reference' | 'incompatible_edge_endpoint' | 'cycle_detected';
export interface ValidationIssue {
    readonly kind: ValidationIssueKind;
    readonly subjectId: XoirNodeId | XoirEdgeId | undefined;
    readonly message: string;
}
export interface ValidationReport {
    readonly valid: boolean;
    readonly issues: readonly ValidationIssue[];
}
/**
 * Structural + content validation for a whole graph. Never throws —
 * validation failures are exactly the "expected, recoverable" case
 * `docs/CODING_STANDARDS.md` describes: a caller (a future compiler pass,
 * `xo verify`) branches on `report.valid`, it doesn't catch an exception.
 */
export declare function validateGraph(graph: XoirGraph): ValidationReport;
//# sourceMappingURL=validation.d.ts.map
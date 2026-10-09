import { verifyEdgeHash, verifyNodeHash } from './hashing.js';
import { isSchemaVersionSupported } from './versioning.js';
/**
 * The minimum properties each known node kind must carry to be considered
 * structurally valid — a lightweight, additive analogue of the per-kind
 * property interfaces in node-kinds.ts, kept as plain string keys here
 * rather than re-deriving it from the TypeScript types, since this check
 * runs against data that may have been deserialized from an *older*
 * schema version (see versioning.ts) where the static type isn't
 * necessarily trustworthy.
 */
const REQUIRED_PROPERTIES_BY_KNOWN_KIND = {
    // Canonical (reconciliation report §3, §4)
    concept: ['definition'],
    fact: ['statement', 'domain'],
    heuristic: ['condition', 'action'],
    decision_node: ['question', 'outcome', 'rationale'],
    reasoning_step: ['premise', 'conclusion'],
    preference: ['dimension', 'value'],
    risk_policy: ['domain', 'toleranceLevel'],
    escalation_rule: ['triggerCondition', 'escalationTarget'],
    failure_case: ['scenario', 'rootCause'],
    success_pattern: ['scenario'],
    capability: ['name', 'description'],
    constraint: ['rule', 'severity'],
    safety_policy: ['policy', 'trigger', 'action'],
    memory_unit: ['content', 'scope'],
    evaluation_artifact: ['input', 'expectedBehavior'],
    // Legacy (see LegacyXoirNodeKind) — unchanged, still validated so existing schema-version-1 graphs remain valid.
    knowledge: ['statement', 'domain'],
    reasoning: ['premise', 'conclusion'],
    decision: ['question', 'outcome', 'rationale'],
    memory: ['content', 'scope'],
    evaluation: ['criterion', 'method'],
    benchmark: ['category', 'metric'],
    prompt_strategy: ['role', 'template'],
    case_study: ['scenario', 'outcome'],
    metadata: ['key', 'value'],
    provenance: ['contributor', 'role'],
    license: ['tier', 'royaltyBasisPoints'],
    identity: ['did', 'role'],
    version: ['semver', 'changelog'],
};
function isKnownKind(kind) {
    return Object.prototype.hasOwnProperty.call(REQUIRED_PROPERTIES_BY_KNOWN_KIND, kind);
}
/**
 * A small, explicit table of "obviously impossible" edge/endpoint-kind
 * combinations (reconciliation report §14: "Do NOT attempt to create an
 * enormous semantic ontology validator... We want strong structural
 * invariants and a clean extension mechanism"). Only entries with a real,
 * unambiguous rule are listed; everything else is unconstrained by
 * design. `undefined` for `from`/`to` means "no constraint on that side."
 */
const EDGE_ENDPOINT_KIND_CONSTRAINTS = {
    // COMPOSES_INTO is the Linker's capability-composition edge (EXPERIENCE_COMPILER.md §5.5) — both endpoints are Capabilities.
    COMPOSES_INTO: { from: ['capability'], to: ['capability'] },
    // ESCALATES_TO always terminates at either an explicit EscalationRule or the Capability/human process it hands off to — never at a bare Fact/Concept.
    ESCALATES_TO: { to: ['escalation_rule', 'capability'] },
};
function endpointKindAllowed(allowed, actualKind) {
    if (!allowed)
        return true;
    // custom:<name> kinds are always allowed — this table only constrains known kinds.
    if (actualKind.startsWith('custom:'))
        return true;
    return allowed.includes(actualKind);
}
/**
 * Structural + content validation for a whole graph. Never throws —
 * validation failures are exactly the "expected, recoverable" case
 * `docs/CODING_STANDARDS.md` describes: a caller (a future compiler pass,
 * `xo verify`) branches on `report.valid`, it doesn't catch an exception.
 */
export function validateGraph(graph) {
    const issues = [];
    if (!isSchemaVersionSupported(graph.schemaVersion)) {
        issues.push({ kind: 'unsupported_schema_version', subjectId: undefined, message: `Graph schemaVersion ${graph.schemaVersion} is not supported by this build` });
    }
    for (const node of graph.allNodes()) {
        if (!verifyNodeHash(node)) {
            issues.push({ kind: 'hash_mismatch', subjectId: node.id, message: `Node "${node.id}" carried hash does not match a fresh computation` });
        }
        if (node.metadata.confidence < 0 || node.metadata.confidence > 1) {
            issues.push({ kind: 'invalid_confidence_range', subjectId: node.id, message: `Node "${node.id}" confidence ${node.metadata.confidence} is outside [0, 1]` });
        }
        if (node.metadata.confidenceDetail !== undefined && (node.metadata.confidenceDetail.score < 0 || node.metadata.confidenceDetail.score > 1)) {
            issues.push({ kind: 'invalid_confidence_range', subjectId: node.id, message: `Node "${node.id}" confidenceDetail.score ${node.metadata.confidenceDetail.score} is outside [0, 1]` });
        }
        for (const ref of node.metadata.sourceRefs) {
            if (!isNonEmptyString(ref.documentPath)) {
                issues.push({ kind: 'invalid_provenance_reference', subjectId: node.id, message: `Node "${node.id}" has a sourceRef with an empty documentPath` });
            }
        }
        if (isKnownKind(node.kind)) {
            const required = REQUIRED_PROPERTIES_BY_KNOWN_KIND[node.kind];
            for (const key of required) {
                if (!(key in node.properties)) {
                    issues.push({ kind: 'missing_required_property', subjectId: node.id, message: `Node "${node.id}" (kind "${node.kind}") is missing required property "${key}"` });
                }
            }
        }
    }
    for (const edge of graph.allEdges()) {
        if (!verifyEdgeHash(edge)) {
            issues.push({ kind: 'hash_mismatch', subjectId: edge.id, message: `Edge "${edge.id}" carried hash does not match a fresh computation` });
        }
        if (edge.metadata.confidenceDetail !== undefined && (edge.metadata.confidenceDetail.score < 0 || edge.metadata.confidenceDetail.score > 1)) {
            issues.push({ kind: 'invalid_confidence_range', subjectId: edge.id, message: `Edge "${edge.id}" confidenceDetail.score ${edge.metadata.confidenceDetail.score} is outside [0, 1]` });
        }
        for (const ref of edge.metadata.sourceRefs) {
            if (!isNonEmptyString(ref.documentPath)) {
                issues.push({ kind: 'invalid_provenance_reference', subjectId: edge.id, message: `Edge "${edge.id}" has a sourceRef with an empty documentPath` });
            }
        }
        const fromNode = graph.getNode(edge.fromId);
        const toNode = graph.getNode(edge.toId);
        if (!fromNode.ok || !toNode.ok) {
            issues.push({ kind: 'dangling_edge_reference', subjectId: edge.id, message: `Edge "${edge.id}" references a node not present in the graph` });
            continue;
        }
        checkEdgeEndpointCompatibility(edge, fromNode.value, toNode.value, issues);
    }
    return { valid: issues.length === 0, issues };
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function checkEdgeEndpointCompatibility(edge, fromNode, toNode, issues) {
    const constraint = EDGE_ENDPOINT_KIND_CONSTRAINTS[edge.kind];
    if (!constraint)
        return;
    if (!endpointKindAllowed(constraint.from, fromNode.kind)) {
        issues.push({
            kind: 'incompatible_edge_endpoint',
            subjectId: edge.id,
            message: `Edge "${edge.id}" (${edge.kind}) has fromId of kind "${fromNode.kind}", but requires one of [${(constraint.from ?? []).join(', ')}]`,
        });
    }
    if (!endpointKindAllowed(constraint.to, toNode.kind)) {
        issues.push({
            kind: 'incompatible_edge_endpoint',
            subjectId: edge.id,
            message: `Edge "${edge.id}" (${edge.kind}) has toId of kind "${toNode.kind}", but requires one of [${(constraint.to ?? []).join(', ')}]`,
        });
    }
}
//# sourceMappingURL=validation.js.map
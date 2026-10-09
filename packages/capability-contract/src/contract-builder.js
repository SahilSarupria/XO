import { err, ok } from '@xo/types';
import { CapabilityContractError } from '@xo/errors';
import { ErrorCode } from '@xo/errors';
const RULE_KINDS = new Set(['decision_node', 'heuristic', 'constraint']);
/** Strips `@xo/xoir`'s `XoirSourceRef` down to `ContractSourceRef` — dropping `experienceUnitId`/`charOffsetRange`/`sourceConfidence`, which are XOIR-internal bookkeeping this contract's consumers (potentially Runtime, with no `@xo/xoir` dependency) have no use for, per `types.ts`'s "no @xo/xoir at the type level" rule. Every field kept is copied verbatim, never reinterpreted. */
function toContractSourceRef(ref) {
    return {
        documentPath: ref.documentPath,
        ...(ref.locator !== undefined ? { locator: ref.locator } : {}),
        ...(ref.pages !== undefined ? { pages: ref.pages } : {}),
        ...(ref.sectionPath !== undefined ? { sectionPath: ref.sectionPath } : {}),
    };
}
/** `"name: description"` -> `{name, description}`, the inverse of `@xo/compiler`'s `formatParams` (`xoir/capability-to-xoir.ts`) — never fabricates a description the compiler didn't already flatten in. A bare name with no `": "` separator becomes `{name, description: ''}`, not a guess. */
function parseParam(entry) {
    const sepIndex = entry.indexOf(': ');
    if (sepIndex === -1)
        return { name: entry, description: '' };
    return { name: entry.slice(0, sepIndex), description: entry.slice(sepIndex + 2) };
}
function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * Phase 2: `HeuristicNodeProps.structuredCondition` etc. are typed on the
 * XOIR side as loose `Record<string, XoirValue>` bags (see
 * `node-kinds.ts`'s own doc comment on why), but by construction they are
 * always built by `@xo/compiler`'s `structured-semantics.ts` from exactly
 * this package's own `parseStructuredCondition`/`parseStructuredAction`
 * output, JSON-round-tripped. This function is therefore a plain,
 * lossless re-typing of already-validated data — never a place that
 * invents or reinterprets structure — mirroring how `contract-embed.ts`
 * already treats `semanticCapabilityContract` property bags as trusted,
 * pre-shaped JSON.
 */
function toStructuredCondition(value) {
    return value === undefined || value === null ? undefined : value;
}
function toStructuredAction(value) {
    return value === undefined || value === null ? undefined : value;
}
function toStructuredExceptions(value) {
    return value === undefined || value === null ? undefined : value;
}
function buildRuleFromNode(node) {
    if (node.kind === 'decision_node') {
        const props = node.properties;
        const structuredCondition = toStructuredCondition(props.structuredCondition);
        const structuredAction = toStructuredAction(props.structuredAction);
        return {
            sourceNodeId: node.id,
            kind: 'decision_node',
            condition: props.question,
            outcome: props.outcome,
            exceptionConditions: [],
            confidence: node.metadata.confidence,
            ...(structuredCondition !== undefined ? { structuredCondition } : {}),
            ...(structuredAction !== undefined ? { structuredAction } : {}),
        };
    }
    if (node.kind === 'heuristic') {
        const props = node.properties;
        const structuredCondition = toStructuredCondition(props.structuredCondition);
        const structuredAction = toStructuredAction(props.structuredAction);
        const structuredExceptions = toStructuredExceptions(props.structuredExceptions);
        return {
            sourceNodeId: node.id,
            kind: 'heuristic',
            condition: props.condition,
            outcome: props.action,
            exceptionConditions: props.exceptionConditions ?? [],
            confidence: node.metadata.confidence,
            ...(structuredCondition !== undefined ? { structuredCondition } : {}),
            ...(structuredAction !== undefined ? { structuredAction } : {}),
            ...(structuredExceptions !== undefined ? { structuredExceptions } : {}),
        };
    }
    if (node.kind === 'constraint') {
        const props = node.properties;
        const structuredCondition = toStructuredCondition(props.structuredCondition);
        return {
            sourceNodeId: node.id,
            kind: 'constraint',
            condition: props.rule,
            exceptionConditions: [],
            confidence: node.metadata.confidence,
            ...(structuredCondition !== undefined ? { structuredCondition } : {}),
        };
    }
    return undefined;
}
/**
 * Projects one XOIR `capability` node, plus every `decision_node`/
 * `heuristic`/`constraint` node connected to it by a `REQUIRES` edge in
 * either direction (see `BuildContractOptions.linkEdgeKind`'s doc comment
 * for why both directions are real, independent evidence), into a
 * `SemanticCapabilityContract`. Pure and deterministic: same graph,
 * same capability node id, same contract, every time — no timestamps, no
 * randomness, and never a value invented beyond what the XOIR node itself
 * carries (see `types.ts`'s doc comment).
 *
 * Fails (`CONTRACT_SOURCE_NODE_NOT_FOUND`) if `capabilityNodeId` doesn't
 * resolve to a node in `graph`, and (`CONTRACT_SOURCE_NODE_INVALID`) if it
 * resolves to a node that isn't kind `'capability'` — this builder never
 * silently treats an unrelated node as a capability.
 */
export function buildSemanticCapabilityContract(graph, capabilityNodeId, options = {}) {
    const nodeResult = graph.getNode(capabilityNodeId);
    if (!nodeResult.ok) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND, `No XOIR node found for capability node id "${capabilityNodeId}"`));
    }
    const node = nodeResult.value;
    if (node.kind !== 'capability') {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_INVALID, `Node "${capabilityNodeId}" is kind "${node.kind}", not "capability" — cannot build a SemanticCapabilityContract from it`));
    }
    const props = node.properties;
    const linkEdgeKind = options.linkEdgeKind ?? 'REQUIRES';
    // 'both': see BuildContractOptions.linkEdgeKind's doc comment on why a rule node can
    // legitimately be reached via either an incoming (content-mention linking) or outgoing
    // (Capability.requiredKnowledgeNodeIds) REQUIRES edge. The same node can in principle be
    // reached via an edge in each direction at once (independent evidence from two independent
    // passes) — deduped by node id below so it becomes exactly one SemanticCapabilityRule, never
    // a double-counted one.
    const linkedNodes = graph.neighbors(node.id, { edgeKind: linkEdgeKind, direction: 'both' }).filter((n) => RULE_KINDS.has(n.kind));
    const seenRuleNodeIds = new Set();
    const dedupedLinkedNodes = linkedNodes.filter((n) => {
        if (seenRuleNodeIds.has(n.id))
            return false;
        seenRuleNodeIds.add(n.id);
        return true;
    });
    const rules = dedupedLinkedNodes
        .map(buildRuleFromNode)
        .filter((r) => r !== undefined)
        .slice()
        .sort((a, b) => (a.sourceNodeId < b.sourceNodeId ? -1 : a.sourceNodeId > b.sourceNodeId ? 1 : 0));
    const determinism = props.determinism ?? 'unknown';
    const contract = {
        id: node.id,
        name: props.name,
        description: props.description,
        ...(props.category !== undefined ? { category: props.category } : {}),
        inputs: (props.inputs ?? []).map(parseParam),
        outputs: (props.outputs ?? []).map(parseParam),
        requiredPermissions: props.requiredPermissions ?? [],
        determinism,
        rules,
        confidence: node.metadata.confidence,
        sourceRefs: node.metadata.sourceRefs.map(toContractSourceRef),
        sourceXoirNodeIds: [node.id, ...rules.map((r) => r.sourceNodeId)].sort(),
    };
    return ok(contract);
}
/** Convenience: every `capability` node in `graph`, each built into its own contract independently. A single node's build failure does not abort the whole batch — see `results`'s per-id outcome. */
export function buildAllSemanticCapabilityContracts(graph, options = {}) {
    const capabilityNodes = graph.allNodes().filter((n) => n.kind === 'capability').slice().sort(byId);
    return capabilityNodes.map((n) => buildSemanticCapabilityContract(graph, n.id, options));
}
//# sourceMappingURL=contract-builder.js.map
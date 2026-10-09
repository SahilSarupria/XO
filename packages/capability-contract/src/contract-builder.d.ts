import { type Result } from '@xo/types';
import { CapabilityContractError } from '@xo/errors';
import type { XoirGraph, XoirNodeId } from '@xo/xoir';
import type { SemanticCapabilityContract } from './types.js';
export interface BuildContractOptions {
    /**
     * Which edge kind links a capability node to its supporting rule/decision
     * nodes. Defaults to `'REQUIRES'` — considered in *both* directions (see
     * `direction: 'both'` below), because two independent, equally legitimate
     * `@xo/compiler` mechanisms each produce a real `REQUIRES` edge between a
     * capability and a rule-kind node, in opposite directions:
     *
     *   - `reasoning-to-xoir.ts`/`knowledge-to-xoir.ts`'s best-effort
     *     content-mention linking (`rule-capability-linking.ts`) creates
     *     `decision_node/heuristic/constraint --REQUIRES--> capability` (the
     *     rule node is the edge's `fromId`) — reached via *incoming* edges.
     *   - `capability-to-xoir.ts`'s own `Capability.requiredKnowledgeNodeIds`
     *     pass creates `capability --REQUIRES--> knowledgeNode` (the
     *     capability is the edge's `fromId`) — reached via *outgoing* edges.
     *     `requiredKnowledgeNodeIds` is populated by Stage 5's own
     *     content-mention scan over *every* Stage 4 knowledge node
     *     (`rule-based-extractor.ts#findMentionedKnowledgeNodes` does not
     *     filter by semantic type), so it can and does legitimately name a
     *     `constraint`/`obligation`/`exception` node — i.e. a rule node —
     *     not only `concept`/`fact` ones. Restricting this lookup to
     *     `incoming` only, as an earlier version of this builder did, silently
     *     dropped exactly that case even though the edge already existed in
     *     the graph, deterministically and provenance-backed.
     *
     * Both directions are filtered identically by `RULE_KINDS` below, so
     * `direction: 'both'` never pulls in an unrelated neighbor (e.g. a
     * `dependencies`-derived `capability --REQUIRES--> capability` edge) —
     * only a node of kind `decision_node`/`heuristic`/`constraint` survives
     * either way. Verified directly against every producing adapter's source
     * before writing this, not assumed.
     */
    readonly linkEdgeKind?: string;
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
export declare function buildSemanticCapabilityContract(graph: XoirGraph, capabilityNodeId: XoirNodeId, options?: BuildContractOptions): Result<SemanticCapabilityContract, CapabilityContractError>;
/** Convenience: every `capability` node in `graph`, each built into its own contract independently. A single node's build failure does not abort the whole batch — see `results`'s per-id outcome. */
export declare function buildAllSemanticCapabilityContracts(graph: XoirGraph, options?: BuildContractOptions): readonly Result<SemanticCapabilityContract, CapabilityContractError>[];
//# sourceMappingURL=contract-builder.d.ts.map
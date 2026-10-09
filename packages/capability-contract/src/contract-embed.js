import { err, ok } from '@xo/types';
import { CapabilityContractError, ErrorCode } from '@xo/errors';
import { buildSemanticCapabilityContract } from './contract-builder.js';
/**
 * `SemanticCapabilityContract` -> a plain `Record<string, XoirValue>` bag,
 * safe to assign to `CapabilityNodeProps.semanticCapabilityContract`. Every
 * field is already string/number/boolean/array/plain-object, so this is a
 * structural identity conversion, not a lossy re-encoding — nothing here
 * approximates or drops a field.
 */
function contractToPropertyBag(contract) {
    return JSON.parse(JSON.stringify(contract));
}
/**
 * `XoirGraph` has no "replace a node's properties in place" primitive —
 * only `removeNode` + `createAndAddNode` (see both functions below). This
 * is the one place that pairing is done, so it is the one place edges get
 * lost if it's done carelessly: `graph.removeNode()` deletes every edge
 * touching the removed node as an intentional part of *deleting* a node
 * (a dangling edge would be a graph integrity violation) — but that is
 * the wrong behavior for *replacing* a node's properties under the same
 * id, where the node's identity and its relationships haven't actually
 * changed, only one property bag has. This helper captures every edge
 * touching `node.id` before removal and re-adds each one, byte-for-byte
 * (`graph.addEdge`, not `createAndAddEdge` — so the SAME `XoirEdge`
 * object, including its original `hash`, `weight`, `properties`, and
 * `metadata`, is restored rather than a freshly-hashed reconstruction),
 * after the replacement node is added back under the same id. Both
 * `embedContractInCapabilityNode` and `embedResolvedContractInCapabilityNode`
 * below call this rather than duplicating the remove/re-add sequence.
 *
 * `version` and `now` are passed explicitly to `createAndAddNode` so the
 * replacement node keeps the original node's `version` and `createdAt`
 * rather than silently resetting to `version: 1` / "now" — `createNode`
 * (`@xo/xoir`) defaults both when omitted, and `createdAt` is documented
 * provenance (`hashing.ts#hashNode` hashes it deliberately), not a
 * "last touched" timestamp this function should be allowed to bump as a
 * side effect of an unrelated properties change.
 */
function replaceCapabilityNodeProperties(graph, node, newProperties) {
    const touchingEdges = graph.allEdges().filter((e) => e.fromId === node.id || e.toId === node.id);
    const removeResult = graph.removeNode(node.id);
    if (!removeResult.ok) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_MALFORMED, `Failed to remove node "${node.id}" before re-adding it with an embedded contract: ${removeResult.error.message}`));
    }
    const addResult = graph.createAndAddNode({
        id: node.id,
        kind: 'capability',
        properties: newProperties,
        sourceRefs: node.metadata.sourceRefs,
        tags: node.metadata.tags,
        custom: node.metadata.custom,
        version: node.version,
        now: () => node.metadata.createdAt,
        ...(node.metadata.confidenceDetail !== undefined ? { confidenceDetail: node.metadata.confidenceDetail } : { confidence: node.metadata.confidence }),
        ...(node.metadata.subtype !== undefined ? { subtype: node.metadata.subtype } : {}),
    });
    if (!addResult.ok) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_MALFORMED, `Failed to re-add node "${node.id}" with an embedded contract: ${addResult.error.message}`));
    }
    for (const edge of touchingEdges) {
        const readdResult = graph.addEdge(edge);
        if (!readdResult.ok) {
            return err(new CapabilityContractError(ErrorCode.CONTRACT_MALFORMED, `Failed to restore edge "${edge.id}" (${edge.kind}: ${edge.fromId} -> ${edge.toId}) after re-adding node "${node.id}" with an embedded contract: ${readdResult.error.message}`));
        }
    }
    return ok(addResult.value);
}
/**
 * Builds a `SemanticCapabilityContract` for `capabilityNodeId` (via
 * `buildSemanticCapabilityContract`) and replaces that node in `graph`
 * with an otherwise-identical node whose properties additionally carry
 * the built contract under `semanticCapabilityContract`. All other node
 * metadata (confidence, sourceRefs, tags, subtype, version) is carried
 * over unchanged, and every edge touching this node — `REQUIRES`,
 * `escalates_to`, any kind — survives (see
 * `replaceCapabilityNodeProperties`). Only `properties` changes, which
 * legitimately changes the node's content hash (a node's hash is a
 * function of its content; adding a real field is a real content change,
 * not an artifact of this function).
 *
 * This is a compiler-time operation only — it requires a live `XoirGraph`
 * and is not, and must not become, something `@xo/runtime` calls (Runtime
 * has no dependency on `@xo/xoir`; see `extractContractFromPropertyBag`
 * below for the runtime-side counterpart, which needs no `XoirGraph`).
 */
export function embedContractInCapabilityNode(graph, capabilityNodeId, options = {}) {
    const contractResult = buildSemanticCapabilityContract(graph, capabilityNodeId, options);
    if (!contractResult.ok)
        return err(contractResult.error);
    const nodeResult = graph.getNode(capabilityNodeId);
    if (!nodeResult.ok) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND, `No XOIR node found for capability node id "${capabilityNodeId}"`));
    }
    const node = nodeResult.value;
    const existingProps = node.properties;
    return replaceCapabilityNodeProperties(graph, node, { ...existingProps, semanticCapabilityContract: contractToPropertyBag(contractResult.value) });
}
/**
 * The production-packaging counterpart to `embedContractInCapabilityNode`
 * above, for exactly one situation: a caller (`capability-lowering.ts`)
 * that has ALREADY built and resolved a `SemanticCapabilityContract` for
 * this node — via `buildAllSemanticCapabilityContracts` /
 * `resolveCapabilityBinding`, the same calls that produced the
 * `CapabilityDeclaration.execution` that will ship in `manifest.json` —
 * and needs the exact SAME contract embedded into the packaged
 * `knowledge_graph.json`, not a freshly re-resolved one.
 * `embedContractInCapabilityNode` cannot be reused directly for this: it
 * always re-derives its own contract via `buildSemanticCapabilityContract`
 * internally, which would (a) do real, avoidable extraction work twice
 * and (b) risk the manifest's `execution.contractId` and the graph's
 * embedded `semanticCapabilityContract.id` silently diverging if
 * extraction is ever non-idempotent (timestamps, non-deterministic
 * ordering in a future extractor). This function instead takes `contract`
 * as a parameter and only performs the graph-mutation half — the exact
 * same `replaceCapabilityNodeProperties` helper, so edge-preservation
 * behavior is identical between both entry points, verified by the same
 * test suite.
 */
export function embedResolvedContractInCapabilityNode(graph, capabilityNodeId, contract) {
    const nodeResult = graph.getNode(capabilityNodeId);
    if (!nodeResult.ok) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND, `No XOIR node found for capability node id "${capabilityNodeId}"`));
    }
    const node = nodeResult.value;
    const existingProps = node.properties;
    return replaceCapabilityNodeProperties(graph, node, { ...existingProps, semanticCapabilityContract: contractToPropertyBag(contract) });
}
//# sourceMappingURL=contract-embed.js.map
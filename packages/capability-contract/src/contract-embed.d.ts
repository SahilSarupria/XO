import { type Result } from '@xo/types';
import { CapabilityContractError } from '@xo/errors';
import type { XoirGraph, XoirNode, XoirNodeId } from '@xo/xoir';
import { type BuildContractOptions } from './contract-builder.js';
import type { SemanticCapabilityContract } from './types.js';
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
export declare function embedContractInCapabilityNode(graph: XoirGraph, capabilityNodeId: XoirNodeId, options?: BuildContractOptions): Result<XoirNode, CapabilityContractError>;
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
export declare function embedResolvedContractInCapabilityNode(graph: XoirGraph, capabilityNodeId: XoirNodeId, contract: SemanticCapabilityContract): Result<XoirNode, CapabilityContractError>;
//# sourceMappingURL=contract-embed.d.ts.map
import { err, ok } from '@xo/types';
import { CapabilityContractError, ErrorCode } from '@xo/errors';
// No import from @xo/xoir anywhere in this file — this is the runtime-facing
// read path. @xo/runtime reads a mounted package's knowledge_graph.json as
// plain JSON (via @xo/package-sdk, which itself has no @xo/xoir dependency)
// and hands the capability node's `properties` object straight to
// `extractContractFromPropertyBag` below, with no XOIR types involved at
// any point on that call path.
/**
 * The runtime-side counterpart of `contract-embed.ts`'s
 * `embedContractInCapabilityNode`: reads a `SemanticCapabilityContract`
 * back out of a plain properties bag (as read from a mounted package's
 * `knowledge_graph.json`). Performs minimal structural validation (the
 * handful of required fields actually used downstream) rather than a full
 * schema validation, consistent with this contract's own philosophy of
 * trusting what the compiler already verified rather than re-deriving it.
 * Returns `CONTRACT_SOURCE_NODE_NOT_FOUND` when the field is simply
 * absent (an entirely normal state — most capability nodes, and most
 * mounted packages, will have no embedded contract) and
 * `CONTRACT_MALFORMED` only when the field is present but doesn't look
 * like a contract.
 */
export function extractContractFromPropertyBag(properties) {
    const raw = properties['semanticCapabilityContract'];
    if (raw === undefined || raw === null || typeof raw !== 'object') {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND, `No "semanticCapabilityContract" field present in the given properties bag`));
    }
    const candidate = raw;
    if (typeof candidate['id'] !== 'string' || typeof candidate['name'] !== 'string' || !Array.isArray(candidate['rules'])) {
        return err(new CapabilityContractError(ErrorCode.CONTRACT_MALFORMED, `"semanticCapabilityContract" is present but missing required fields (id/name/rules)`));
    }
    return ok(candidate);
}
//# sourceMappingURL=contract-extract.js.map
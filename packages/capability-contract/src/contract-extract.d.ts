import { type Result } from '@xo/types';
import { CapabilityContractError } from '@xo/errors';
import type { SemanticCapabilityContract } from './types.js';
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
export declare function extractContractFromPropertyBag(properties: Readonly<Record<string, unknown>>): Result<SemanticCapabilityContract, CapabilityContractError>;
//# sourceMappingURL=contract-extract.d.ts.map
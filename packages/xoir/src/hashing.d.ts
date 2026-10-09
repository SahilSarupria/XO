import { ContentHash } from '@xo/types';
import { type Hasher } from '@xo/crypto';
import type { XoirEdge, XoirEdgeKind } from './edge-kinds.js';
import type { XoirNode, XoirNodeKind } from './node-kinds.js';
import type { XoirValue } from './values.js';
/**
 * Deterministically stringifies a JSON-shaped value: object keys are
 * sorted, arrays keep their order (order is meaningful data, not
 * incidental), and there is exactly one textual representation of any
 * given value. This is the "canonical serialization" the module's Core
 * Principles require, and it is what every hash in this file is computed
 * over — two nodes with the same fields in a different property-insertion
 * order must hash identically.
 */
export declare function canonicalStringify(value: XoirValue): string;
/**
 * Hashes everything about a node except `hash` itself (hashing a field
 * that contains its own hash would be circular) and except `updatedAt`
 * (a node's identity/content hash should reflect *what it says*, not
 * *when it was last touched* — two nodes created at different times with
 * identical content are, for merge/diff purposes in merge.ts/diff.ts,
 * the same content). `createdAt` IS included, since it is (deliberately)
 * treated as part of a node's provenance rather than a volatile
 * bookkeeping field.
 */
export declare function hashNode<K extends XoirNodeKind, P extends Record<string, XoirValue>>(node: Omit<XoirNode<K, P>, 'hash'>, hasher?: Hasher): ContentHash;
export declare function hashEdge<K extends XoirEdgeKind, P extends Record<string, XoirValue>>(edge: Omit<XoirEdge<K, P>, 'hash'>, hasher?: Hasher): ContentHash;
/** True if `node.hash` still matches a fresh computation over its current fields — i.e. nothing mutated the node's data out from under its carried hash. */
export declare function verifyNodeHash(node: XoirNode, hasher?: Hasher): boolean;
export declare function verifyEdgeHash(edge: XoirEdge, hasher?: Hasher): boolean;
/**
 * A whole graph's content-addressable identity: the Merkle root over every
 * node hash and every edge hash, each sorted by id first so the root is
 * insensitive to insertion order (two graphs with the same nodes/edges
 * added in a different order produce the same graph hash).
 */
export declare function hashGraphContents(nodeHashes: readonly ContentHash[], edgeHashes: readonly ContentHash[], hasher?: Hasher): ContentHash;
//# sourceMappingURL=hashing.d.ts.map
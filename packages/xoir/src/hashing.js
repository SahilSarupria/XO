import { ContentHash } from '@xo/types';
import { Sha256Hasher, buildMerkleRoot } from '@xo/crypto';
/**
 * Deterministically stringifies a JSON-shaped value: object keys are
 * sorted, arrays keep their order (order is meaningful data, not
 * incidental), and there is exactly one textual representation of any
 * given value. This is the "canonical serialization" the module's Core
 * Principles require, and it is what every hash in this file is computed
 * over — two nodes with the same fields in a different property-insertion
 * order must hash identically.
 */
export function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const obj = value;
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    return `{${entries.join(',')}}`;
}
const defaultHasher = new Sha256Hasher();
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
export function hashNode(node, hasher = defaultHasher) {
    const canonical = canonicalStringify({
        id: node.id,
        kind: node.kind,
        properties: node.properties,
        version: node.version,
        confidence: node.metadata.confidence,
        confidenceDetail: node.metadata.confidenceDetail ?? null,
        subtype: node.metadata.subtype ?? null,
        sourceRefs: node.metadata.sourceRefs,
        tags: node.metadata.tags,
        createdAt: node.metadata.createdAt,
        custom: node.metadata.custom,
    });
    return ContentHash(hasher.hash(canonical));
}
export function hashEdge(edge, hasher = defaultHasher) {
    const canonical = canonicalStringify({
        id: edge.id,
        kind: edge.kind,
        fromId: edge.fromId,
        toId: edge.toId,
        properties: edge.properties,
        weight: edge.weight ?? null,
        confidence: edge.metadata.confidence,
        confidenceDetail: edge.metadata.confidenceDetail ?? null,
        sourceRefs: edge.metadata.sourceRefs,
        tags: edge.metadata.tags,
        createdAt: edge.metadata.createdAt,
        custom: edge.metadata.custom,
    });
    return ContentHash(hasher.hash(canonical));
}
/** True if `node.hash` still matches a fresh computation over its current fields — i.e. nothing mutated the node's data out from under its carried hash. */
export function verifyNodeHash(node, hasher = defaultHasher) {
    return hashNode(node, hasher) === node.hash;
}
export function verifyEdgeHash(edge, hasher = defaultHasher) {
    return hashEdge(edge, hasher) === edge.hash;
}
/**
 * A whole graph's content-addressable identity: the Merkle root over every
 * node hash and every edge hash, each sorted by id first so the root is
 * insensitive to insertion order (two graphs with the same nodes/edges
 * added in a different order produce the same graph hash).
 */
export function hashGraphContents(nodeHashes, edgeHashes, hasher = defaultHasher) {
    const allHashes = [...nodeHashes].sort().concat([...edgeHashes].sort());
    if (allHashes.length === 0) {
        return ContentHash(hasher.hash('xoir:empty-graph'));
    }
    return ContentHash(buildMerkleRoot(allHashes, hasher));
}
//# sourceMappingURL=hashing.js.map
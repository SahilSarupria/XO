import { ContentHash } from '@xo/types';
import { Sha256Hasher, buildMerkleRoot, type Hasher } from '@xo/crypto';
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
export function canonicalStringify(value: XoirValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const obj = value as { readonly [key: string]: XoirValue };
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k] as XoirValue)}`);
  return `{${entries.join(',')}}`;
}

const defaultHasher: Hasher = new Sha256Hasher();

/**
 * Hashes everything about a node except `hash` itself (hashing a field
 * that contains its own hash would be circular), except `updatedAt`
 * (a node's identity/content hash should reflect *what it says*, not
 * *when it was last touched* — two nodes created at different times with
 * identical content are, for merge/diff purposes in merge.ts/diff.ts,
 * the same content), and except `reviewStatus` (P0.9A area A — a future
 * review action is expected to set this on an *existing* node without
 * forking its identity, exactly the same reasoning as `updatedAt`'s
 * exclusion). `createdAt` IS included, since it is (deliberately)
 * treated as part of a node's provenance rather than a volatile
 * bookkeeping field. `producedBy` IS included too — unlike
 * `reviewStatus`, it is set once at creation and never revised, so it
 * belongs with `subtype`/`confidence` as part of the node's identity.
 */
export function hashNode<K extends XoirNodeKind, P extends Record<string, XoirValue>>(
  node: Omit<XoirNode<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const canonical = canonicalStringify({
    id: node.id,
    kind: node.kind,
    properties: node.properties as unknown as XoirValue,
    version: node.version,
    confidence: node.metadata.confidence,
    confidenceDetail: (node.metadata.confidenceDetail as unknown as XoirValue) ?? null,
    subtype: node.metadata.subtype ?? null,
    producedBy: node.metadata.producedBy ?? null,
    sourceRefs: node.metadata.sourceRefs as unknown as XoirValue,
    tags: node.metadata.tags as unknown as XoirValue,
    createdAt: node.metadata.createdAt,
    custom: node.metadata.custom,
  });
  return ContentHash(hasher.hash(canonical));
}

export function hashEdge<K extends XoirEdgeKind, P extends Record<string, XoirValue>>(
  edge: Omit<XoirEdge<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const canonical = canonicalStringify({
    id: edge.id,
    kind: edge.kind,
    fromId: edge.fromId,
    toId: edge.toId,
    properties: edge.properties as unknown as XoirValue,
    weight: edge.weight ?? null,
    confidence: edge.metadata.confidence,
    confidenceDetail: (edge.metadata.confidenceDetail as unknown as XoirValue) ?? null,
    sourceRefs: edge.metadata.sourceRefs as unknown as XoirValue,
    tags: edge.metadata.tags as unknown as XoirValue,
    createdAt: edge.metadata.createdAt,
    custom: edge.metadata.custom,
  });
  return ContentHash(hasher.hash(canonical));
}

/** True if `node.hash` still matches a fresh computation over its current fields — i.e. nothing mutated the node's data out from under its carried hash. */
export function verifyNodeHash(node: XoirNode, hasher: Hasher = defaultHasher): boolean {
  return hashNode(node, hasher) === node.hash;
}

export function verifyEdgeHash(edge: XoirEdge, hasher: Hasher = defaultHasher): boolean {
  return hashEdge(edge, hasher) === edge.hash;
}

/**
 * A whole graph's content-addressable identity: the Merkle root over every
 * node hash and every edge hash, each sorted by id first so the root is
 * insensitive to insertion order (two graphs with the same nodes/edges
 * added in a different order produce the same graph hash).
 */
export function hashGraphContents(nodeHashes: readonly ContentHash[], edgeHashes: readonly ContentHash[], hasher: Hasher = defaultHasher): ContentHash {
  const allHashes = [...nodeHashes].sort().concat([...edgeHashes].sort());
  if (allHashes.length === 0) {
    return ContentHash(hasher.hash('xoir:empty-graph'));
  }
  return ContentHash(buildMerkleRoot(allHashes, hasher));
}
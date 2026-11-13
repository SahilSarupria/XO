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
 * UW-1 — the value exactly as it reads back from stored JSON: object members whose value is `undefined` are dropped and `undefined`
 * array elements become `null` (what `JSON.stringify` does). The current hash scheme hashes this form, so a node hashes the same before
 * and after it is stored; without it a node holding an `undefined` (for example an optional field set to `undefined`) would fail
 * verification the moment it was read back. The legacy schemes keep their original form so old hashes still reproduce.
 */
function asStoredJson(value: unknown): XoirValue {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : asStoredJson(v))) as unknown as XoirValue;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = asStoredJson(v);
    return out as XoirValue;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as XoirValue;
}

/**
 * Hashes what a node SAYS: everything except `hash` itself (circular), `updatedAt` and `createdAt` (when a node was made or touched is
 * bookkeeping, not content; two compilations of the same source must produce the same node and graph hashes), and `reviewStatus`
 * (P0.9A area A — a review sets it on an existing node without forking its identity). `producedBy` IS included: it is set once at
 * creation and never revised, so it belongs with `subtype`/`confidence` as part of the node's identity.
 *
 * UW-1 (deterministic hashing): `createdAt` used to be hashed "as provenance". The consequence was that compiling the same bytes twice
 * gave two different graph hashes (observed on `burglary-policy.pdf`), so a graph hash could not say "same compiled knowledge" — which
 * receipts, compiled-workflow reuse (ADR 0021) and knowledge state ids (ADR 0017) all need. `createdAt` stays in the node's metadata.
 * Graphs stored before UW-1 carry hashes over `createdAt` (scheme 1); {@link verifyNodeHash} accepts either scheme, which keeps full
 * tamper detection: any change to a node's content breaks both, and only `createdAt` (not content) differs between them.
 */
export function hashNode<K extends XoirNodeKind, P extends Record<string, XoirValue>>(
  node: Omit<XoirNode<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const canonical = canonicalStringify(
    asStoredJson({
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
      custom: node.metadata.custom,
    }),
  );
  return ContentHash(hasher.hash(canonical));
}

/** Hashes what an edge says; `createdAt` is excluded for the same reason as in {@link hashNode} (UW-1). */
export function hashEdge<K extends XoirEdgeKind, P extends Record<string, XoirValue>>(
  edge: Omit<XoirEdge<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const canonical = canonicalStringify(
    asStoredJson({
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
      custom: edge.metadata.custom,
    }),
  );
  return ContentHash(hasher.hash(canonical));
}

/**
 * Scheme-1 hashes (before UW-1): the same fields plus `createdAt`. Kept only so graphs stored before UW-1 still verify; never used to
 * hash new content.
 */
export function hashNodeLegacyV1<K extends XoirNodeKind, P extends Record<string, XoirValue>>(
  node: Omit<XoirNode<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const { createdAt, ...rest } = node.metadata;
  return ContentHash(
    hasher.hash(
      canonicalStringify({
        id: node.id,
        kind: node.kind,
        properties: node.properties as unknown as XoirValue,
        version: node.version,
        confidence: rest.confidence,
        confidenceDetail: (rest.confidenceDetail as unknown as XoirValue) ?? null,
        subtype: rest.subtype ?? null,
        producedBy: rest.producedBy ?? null,
        sourceRefs: rest.sourceRefs as unknown as XoirValue,
        tags: rest.tags as unknown as XoirValue,
        createdAt,
        custom: rest.custom,
      }),
    ),
  );
}

export function hashEdgeLegacyV1<K extends XoirEdgeKind, P extends Record<string, XoirValue>>(
  edge: Omit<XoirEdge<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  return ContentHash(
    hasher.hash(
      canonicalStringify({
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
      }),
    ),
  );
}

/**
 * Scheme-0 node hashes: scheme 1 before `producedBy` joined the hash. Graphs compiled then (for example
 * `examples/e2e-pdf/output/compiled-xoir.json`) carry these. A scheme-0 hash does not cover `producedBy`; everything else is covered.
 */
export function hashNodeLegacyV0<K extends XoirNodeKind, P extends Record<string, XoirValue>>(
  node: Omit<XoirNode<K, P>, 'hash'>,
  hasher: Hasher = defaultHasher,
): ContentHash {
  const m = node.metadata;
  return ContentHash(
    hasher.hash(
      canonicalStringify({
        id: node.id,
        kind: node.kind,
        properties: node.properties as unknown as XoirValue,
        version: node.version,
        confidence: m.confidence,
        confidenceDetail: (m.confidenceDetail as unknown as XoirValue) ?? null,
        subtype: m.subtype ?? null,
        sourceRefs: m.sourceRefs as unknown as XoirValue,
        tags: m.tags as unknown as XoirValue,
        createdAt: m.createdAt,
        custom: m.custom,
      }),
    ),
  );
}

/** Which hash scheme a node's stored hash was made with, or `undefined` if it matches none (the node was changed). */
export function nodeHashScheme(node: XoirNode, hasher: Hasher = defaultHasher): 'current' | 'legacy-v1' | 'legacy-v0' | undefined {
  if (hashNode(node, hasher) === node.hash) return 'current';
  if (hashNodeLegacyV1(node, hasher) === node.hash) return 'legacy-v1';
  // A scheme-0 node never had `producedBy` hashed, but one carrying it cannot have been sealed by scheme 0 (it predates the field).
  if (node.metadata.producedBy === undefined && hashNodeLegacyV0(node, hasher) === node.hash) return 'legacy-v0';
  return undefined;
}

/**
 * True if `node.hash` matches its content under the current scheme, or under a scheme that sealed graphs stored before UW-1 (v1, and
 * v0 for nodes without `producedBy`). Any change to what the node says fails them all.
 */
export function verifyNodeHash(node: XoirNode, hasher: Hasher = defaultHasher): boolean {
  return nodeHashScheme(node, hasher) !== undefined;
}

export function verifyEdgeHash(edge: XoirEdge, hasher: Hasher = defaultHasher): boolean {
  return hashEdge(edge, hasher) === edge.hash || hashEdgeLegacyV1(edge, hasher) === edge.hash;
}

/**
 * A whole graph's content-addressable identity: the Merkle root over every
 * node hash and every edge hash, each sorted by id first so the root is
 * insensitive to insertion order (two graphs with the same nodes/edges
 * added in a different order produce the same graph hash).
 */
export function hashGraphContents(
  nodeHashes: readonly ContentHash[],
  edgeHashes: readonly ContentHash[],
  hasher: Hasher = defaultHasher,
): ContentHash {
  const allHashes = [...nodeHashes].sort().concat([...edgeHashes].sort());
  if (allHashes.length === 0) {
    return ContentHash(hasher.hash('xoir:empty-graph'));
  }
  return ContentHash(buildMerkleRoot(allHashes, hasher));
}

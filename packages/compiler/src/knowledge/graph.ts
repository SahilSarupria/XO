import { Sha256Hasher, buildMerkleRoot, type Hasher } from '@xo/crypto';
import { err, ok, type Result } from '@xo/types';
import { SerializationError, ErrorCode } from '@xo/errors';
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from './types.js';

const defaultHasher: Hasher = new Sha256Hasher();

/** Deterministically stringifies a plain JSON-like value with object keys sorted — the same technique `@xo/xoir`'s `hashing.ts#canonicalStringify` and `@xo/ai-core`'s `cache.ts` use, reimplemented locally rather than taking on either package as a dependency for one small utility. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/**
 * The graph's content-addressable identity: a Merkle root (reusing
 * `@xo/crypto`'s `buildMerkleRoot`, the same primitive `@xo/xoir` builds
 * its own graph hashing on) over every node's and edge's own canonical
 * hash, each sorted first so the root is insensitive to array order —
 * two `KnowledgeGraph`s with identical nodes/edges in a different order
 * hash identically.
 */
export function hashKnowledgeGraph(graph: KnowledgeGraph, hasher: Hasher = defaultHasher): string {
  const nodeHashes = graph.nodes.map((node) => hasher.hash(canonicalStringify(node)));
  const edgeHashes = graph.edges.map((edge) => hasher.hash(canonicalStringify(edge)));
  const all = [...nodeHashes, ...edgeHashes].sort();
  if (all.length === 0) return hasher.hash('knowledge-graph:empty');
  return buildMerkleRoot(all, hasher);
}

export function findKnowledgeNode(graph: KnowledgeGraph, id: string): KnowledgeNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function findEdgesFrom(graph: KnowledgeGraph, nodeId: string): readonly KnowledgeEdge[] {
  return graph.edges.filter((e) => e.fromNodeId === nodeId);
}

export function findEdgesTo(graph: KnowledgeGraph, nodeId: string): readonly KnowledgeEdge[] {
  return graph.edges.filter((e) => e.toNodeId === nodeId);
}

/** Canonical wire shape: nodes and edges sorted by id (they already are, coming out of `merge.ts`/`relationship-builder.ts`, but this function doesn't rely on that — it sorts again itself, so it's correct even given an arbitrarily-ordered `KnowledgeGraph`). */
export function serializeKnowledgeGraph(graph: KnowledgeGraph): string {
  const sorted: KnowledgeGraph = {
    nodes: [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...graph.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return JSON.stringify(sorted);
}

function isKnowledgeGraphShape(value: unknown): value is KnowledgeGraph {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<KnowledgeGraph>;
  return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

export function deserializeKnowledgeGraph(json: string): Result<KnowledgeGraph, SerializationError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_PARSE_FAILED, 'Failed to parse KnowledgeGraph JSON', { cause }));
  }
  if (!isKnowledgeGraphShape(parsed)) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Parsed JSON does not have the shape of a KnowledgeGraph ({ nodes: [], edges: [] })'));
  }
  return ok(parsed);
}

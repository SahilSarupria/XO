import { Sha256Hasher, buildMerkleRoot, type Hasher } from '@xo/crypto';
import { err, ok, type Result } from '@xo/types';
import { SerializationError, ErrorCode } from '@xo/errors';
import type { Capability, CapabilityGraph, CapabilityRelationship } from './types.js';

const defaultHasher: Hasher = new Sha256Hasher();

/** Deterministically stringifies a plain JSON-like value with object keys sorted — the same small local utility `../knowledge/graph.ts` uses, for the same reason (one small utility, not worth an extra package dependency's type coupling). */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/**
 * The graph's content-addressable identity — a Merkle root over every
 * capability's and relationship's own canonical hash, sorted first so
 * the root is insensitive to array order. Identical in strategy to
 * `../knowledge/graph.ts#hashKnowledgeGraph`, per the Stage 5 brief's
 * "same deterministic hashing strategy as KnowledgeGraph."
 */
export function hashCapabilityGraph(graph: CapabilityGraph, hasher: Hasher = defaultHasher): string {
  const capabilityHashes = graph.capabilities.map((c) => hasher.hash(canonicalStringify(c)));
  const relationshipHashes = graph.relationships.map((r) => hasher.hash(canonicalStringify(r)));
  const all = [...capabilityHashes, ...relationshipHashes].sort();
  if (all.length === 0) return hasher.hash('capability-graph:empty');
  return buildMerkleRoot(all, hasher);
}

export function findCapability(graph: CapabilityGraph, id: string): Capability | undefined {
  return graph.capabilities.find((c) => c.id === id);
}

export function findRelationshipsFrom(graph: CapabilityGraph, capabilityId: string): readonly CapabilityRelationship[] {
  return graph.relationships.filter((r) => r.fromCapabilityId === capabilityId);
}

export function findRelationshipsTo(graph: CapabilityGraph, capabilityId: string): readonly CapabilityRelationship[] {
  return graph.relationships.filter((r) => r.toCapabilityId === capabilityId);
}

/** Canonical wire shape: capabilities and relationships sorted by id. */
export function serializeCapabilityGraph(graph: CapabilityGraph): string {
  const sorted: CapabilityGraph = {
    capabilities: [...graph.capabilities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relationships: [...graph.relationships].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return JSON.stringify(sorted);
}

function isCapabilityGraphShape(value: unknown): value is CapabilityGraph {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CapabilityGraph>;
  return Array.isArray(v.capabilities) && Array.isArray(v.relationships);
}

export function deserializeCapabilityGraph(json: string): Result<CapabilityGraph, SerializationError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_PARSE_FAILED, 'Failed to parse CapabilityGraph JSON', { cause }));
  }
  if (!isCapabilityGraphShape(parsed)) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Parsed JSON does not have the shape of a CapabilityGraph ({ capabilities: [], relationships: [] })'));
  }
  return ok(parsed);
}

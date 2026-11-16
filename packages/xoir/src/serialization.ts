import { err, ok, type Result } from '@xo/types';
import { SerializationError, ErrorCode } from '@xo/errors';
import { jsonCodec, type Codec } from '@xo/serialization';
import type { XoirEdge } from './edge-kinds.js';
import { verifyEdgeHash, verifyNodeHash } from './hashing.js';
import { XoirGraph } from './graph.js';
import { XoirGraphId } from './ids.js';
import type { XoirManifest } from './manifest.js';
import type { XoirNode } from './node-kinds.js';
import { isSchemaVersionSupported } from './versioning.js';

/**
 * The canonical on-disk/wire shape of a XOIR graph. Nodes and edges are
 * sorted by id before serialization (see {@link toJSON}), which is what
 * makes this format's hash-of-the-serialized-form stable regardless of
 * the order operations happened to occur in while building the graph in
 * memory — "stable ordering" and "deterministic hashing" from the module's
 * Core Principles, applied at the wire-format layer (graph.ts's
 * `contentHash()` is the equivalent for the in-memory structure, and the
 * two agree because both hash from sorted node/edge hash lists).
 */
export interface XoirGraphJson {
  readonly schemaVersion: number;
  readonly id: string;
  readonly nodes: readonly XoirNode[];
  readonly edges: readonly XoirEdge[];
  /** Optional (manifest.ts#XoirManifest) — additive field, absent on older serialized graphs. */
  readonly manifest?: XoirManifest;
}

function isXoirGraphJson(value: unknown): value is XoirGraphJson {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<XoirGraphJson>;
  return typeof v.schemaVersion === 'number' && typeof v.id === 'string' && Array.isArray(v.nodes) && Array.isArray(v.edges);
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function toJson(graph: XoirGraph): XoirGraphJson {
  return {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    nodes: [...graph.allNodes()].sort(byId),
    edges: [...graph.allEdges()].sort(byId),
    ...(graph.manifest !== undefined ? { manifest: graph.manifest } : {}),
  };
}

/**
 * Reconstructs a {@link XoirGraph} from its JSON form. Version-aware: a
 * `schemaVersion` this build doesn't recognize (per
 * `versioning.ts#isSchemaVersionSupported`) is rejected explicitly rather
 * than silently misinterpreted — "forward compatibility" here means "fail
 * clearly on an unknown future version", not "guess at its shape".
 * By default individual nodes/edges are trusted as already-valid (their
 * own `hash` fields are not re-verified) — appropriate for an in-memory
 * round trip. UW-1: pass `{ verify: true }` whenever the JSON crossed a
 * trust boundary (read from disk, received from a client): every node and
 * edge hash is then recomputed and any mismatch fails the load with
 * `XO_SERIALIZATION_INTEGRITY_FAILED` (fail closed). Graphs stored before
 * UW-1 verify under the legacy hash scheme (hashing.ts).
 */
export function fromJson(raw: XoirGraphJson, options: { readonly verify?: boolean } = {}): Result<XoirGraph, SerializationError> {
  if (!isSchemaVersionSupported(raw.schemaVersion)) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Unsupported XOIR schemaVersion ${raw.schemaVersion}`));
  }
  const graph = new XoirGraph(XoirGraphId(raw.id), raw.schemaVersion, raw.manifest);
  for (const node of raw.nodes) {
    const result = graph.addNode(node);
    if (!result.ok) {
      return err(
        new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Failed to reconstruct node "${node.id}": ${result.error.message}`),
      );
    }
  }
  for (const edge of raw.edges) {
    const result = graph.addEdge(edge);
    if (!result.ok) {
      return err(
        new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Failed to reconstruct edge "${edge.id}": ${result.error.message}`),
      );
    }
  }
  // Integrity after structure: a structurally broken graph reports what is broken; a well-formed one must also match its hashes.
  if (options.verify === true) {
    for (const node of raw.nodes) {
      if (!safely(() => verifyNodeHash(node))) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_INTEGRITY_FAILED, `XOIR node "${node.id}" does not match its hash`));
      }
    }
    for (const edge of raw.edges) {
      if (!safely(() => verifyEdgeHash(edge))) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_INTEGRITY_FAILED, `XOIR edge "${edge.id}" does not match its hash`));
      }
    }
  }
  return ok(graph);
}

/** A value that cannot even be hashed does not match its hash. */
function safely(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/** A `@xo/serialization` `Codec<XoirGraph>` for callers that want the standard encode/decode-to-string boundary (e.g. `BlobStore.put(key, xoirGraphCodec.encode(graph))`). */
export const xoirGraphCodec: Codec<XoirGraph> = {
  encode(graph: XoirGraph): string {
    return jsonCodec<XoirGraphJson>().encode(toJson(graph));
  },
  decode(rawText: string): Result<XoirGraph, SerializationError> {
    const parsed = jsonCodec<XoirGraphJson>({ validate: isXoirGraphJson }).decode(rawText);
    if (!parsed.ok) return err(parsed.error);
    return fromJson(parsed.value, { verify: true });
  },
};

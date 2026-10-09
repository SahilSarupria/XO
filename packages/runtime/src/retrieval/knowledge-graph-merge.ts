import type { RetrievedSlice } from './retrieved-slice.js';

/**
 * A generic, deterministic node/edge graph shape — the repo has no fixed
 * `knowledge_graph` component schema (`PACKAGE_README.md`'s reference
 * package describes "8 doc types, 22 clause types, typed relationships"
 * as domain content, not a wire format), so this accepts anything with
 * `nodes`/`edges` arrays and treats each node/edge as an opaque record,
 * keyed by its own `id` field for nodes. Malformed or non-JSON
 * `knowledge_graph` content is skipped, not thrown on — one package's
 * unparseable knowledge graph shouldn't fail every other package's.
 */
export interface KnowledgeGraphDocument {
  readonly nodes: readonly Readonly<Record<string, unknown>>[];
  readonly edges: readonly Readonly<Record<string, unknown>>[];
}

export interface KnowledgeGraphConflict {
  readonly nodeId: string;
  /** Every source (`"name@version"`) that declared this node id, in the order encountered. */
  readonly sources: readonly string[];
}

export interface MergedKnowledgeGraph extends KnowledgeGraphDocument {
  readonly sourceCount: number;
  /** Node ids declared by more than one source with differing content — surfaced, not silently overwritten (first-seen wins for the kept node, matching `sources`' order). */
  readonly conflicts: readonly KnowledgeGraphConflict[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnowledgeGraphDocument(value: unknown): value is KnowledgeGraphDocument {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Parses a `knowledge_graph` slice's content; returns `undefined` for any other component kind or unparseable/malformed content, never throws. */
export function parseKnowledgeGraphSlice(slice: RetrievedSlice): KnowledgeGraphDocument | undefined {
  if (slice.componentKind !== 'knowledge_graph') return undefined;
  try {
    const parsed: unknown = JSON.parse(slice.content);
    return isKnowledgeGraphDocument(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges every `knowledge_graph` slice present in `slices` (across
 * however many mounted packages they came from) into one document —
 * "merging multiple knowledge graphs" from the Stage 2 brief. Nodes are
 * deduplicated by id (first occurrence wins; a later source declaring
 * the same id with different content is recorded in `conflicts`, not
 * silently dropped or overwritten); edges are deduplicated by deep
 * equality. Iterates `slices` in the order given, so the result is fully
 * deterministic for a given input order (callers wanting a canonical
 * order should sort `slices` themselves before calling this).
 */
export function mergeKnowledgeGraphs(slices: readonly RetrievedSlice[]): MergedKnowledgeGraph {
  const nodesById = new Map<string, { readonly node: Readonly<Record<string, unknown>>; readonly sources: string[] }>();
  const conflicts: KnowledgeGraphConflict[] = [];
  const edgesSeen = new Set<string>();
  const edges: Record<string, unknown>[] = [];
  let sourceCount = 0;

  for (const slice of slices) {
    const doc = parseKnowledgeGraphSlice(slice);
    if (!doc) continue;
    sourceCount += 1;
    const sourceLabel = `${slice.packageName}@${slice.packageVersion}`;

    for (const node of doc.nodes) {
      const id = typeof node.id === 'string' ? node.id : undefined;
      if (id === undefined) continue; // a node without an id can't be deduplicated or referenced; skip rather than guess one
      const existing = nodesById.get(id);
      if (!existing) {
        nodesById.set(id, { node, sources: [sourceLabel] });
        continue;
      }
      existing.sources.push(sourceLabel);
      if (JSON.stringify(existing.node) !== JSON.stringify(node)) {
        conflicts.push({ nodeId: id, sources: [...existing.sources] });
      }
    }

    for (const edge of doc.edges) {
      const key = JSON.stringify(edge);
      if (!edgesSeen.has(key)) {
        edgesSeen.add(key);
        edges.push(edge);
      }
    }
  }

  return Object.freeze({
    nodes: [...nodesById.values()].map((entry) => entry.node),
    edges,
    sourceCount,
    conflicts,
  });
}

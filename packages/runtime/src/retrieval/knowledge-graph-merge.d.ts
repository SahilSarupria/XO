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
/** Parses a `knowledge_graph` slice's content; returns `undefined` for any other component kind or unparseable/malformed content, never throws. */
export declare function parseKnowledgeGraphSlice(slice: RetrievedSlice): KnowledgeGraphDocument | undefined;
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
export declare function mergeKnowledgeGraphs(slices: readonly RetrievedSlice[]): MergedKnowledgeGraph;
//# sourceMappingURL=knowledge-graph-merge.d.ts.map
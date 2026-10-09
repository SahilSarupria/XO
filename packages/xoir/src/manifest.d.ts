import type { ContentHash } from '@xo/types';
/**
 * The XOIR manifest/header — package/compilation-level bookkeeping that is
 * deliberately kept OUT of the semantic node graph (reconciliation report
 * §12, §18–20: "Do NOT represent things like license, identity, version,
 * provenance as ordinary semantic XOIR nodes merely because the old XOIR
 * model did so"). Per-node/per-edge *evidentiary* provenance
 * (`node-kinds.ts#XoirSourceRef`) is unaffected by this — a manifest
 * describes the graph as a whole; source refs describe individual claims.
 *
 * A `XoirGraph` MAY carry a manifest (see `graph.ts`'s optional
 * `manifest` constructor argument) — it is not required for a graph to be
 * structurally valid (schema-version-1 graphs never had one), but every
 * graph produced by a real compiler stage from this point forward should
 * set one.
 */
export interface XoirManifest {
    /** Mirrors `XoirGraph.schemaVersion` — duplicated here so a manifest is self-describing if extracted from its graph. */
    readonly schemaVersion: number;
    /** Which build of which compiler produced this graph, e.g. `"@xo/compiler@0.1.0"`. */
    readonly compilerVersion?: string;
    readonly professionTags: readonly string[];
    /** Opaque references to the `SourceManifest`(s) (per `EXPERIENCE_COMPILER.md` §2.1) that fed this graph — XOIR does not interpret these, only carries them. */
    readonly sourceManifestRefs: readonly string[];
    readonly passHistory: readonly PassHistoryEntry[];
    /** The graph's own content hash at the time the manifest was last updated (see `hashing.ts#hashGraphContents`) — a cached, auditable snapshot, not a substitute for recomputing it. */
    readonly graphHash?: ContentHash;
    readonly createdAt: string;
}
/**
 * One recorded compilation-history event (reconciliation report §13).
 * Timestamps here are bookkeeping, same as `XoirNodeMetadata.updatedAt` —
 * they MUST NOT be folded into any node/edge/graph content hash (see
 * `hashing.ts`, which deliberately never reads `manifest.ts` types).
 */
export interface PassHistoryEntry {
    readonly passId: string;
    readonly passVersion: string;
    readonly inputHash: ContentHash;
    readonly outputHash: ContentHash;
    readonly timestamp: string;
    readonly summary?: string;
}
export interface CreateManifestInput {
    readonly schemaVersion: number;
    readonly compilerVersion?: string;
    readonly professionTags?: readonly string[];
    readonly sourceManifestRefs?: readonly string[];
    readonly passHistory?: readonly PassHistoryEntry[];
    readonly graphHash?: ContentHash;
    readonly now?: () => string;
}
export declare function createManifest(input: CreateManifestInput): XoirManifest;
/** Returns a new manifest with one more `PassHistoryEntry` appended — manifests are treated as immutable values, same convention as `XoirNode`/`XoirEdge`. */
export declare function appendPassHistory(manifest: XoirManifest, entry: PassHistoryEntry): XoirManifest;
//# sourceMappingURL=manifest.d.ts.map
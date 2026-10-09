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
  readonly createdAt: string; // ISO-8601
  /**
   * Per-source extraction-quality assessment (P0.9A, area D: "Source
   * quality surfaced"), keyed by `documentPath` — the same identifier
   * `XoirSourceRef.documentPath` (`node-kinds.ts`) uses, so a consumer of
   * a node's own source refs can join back to this map without needing
   * the original in-memory compile result. This is compilation-level
   * bookkeeping about a *source document*, not a claim about any one
   * node's semantics, so — like the rest of this manifest — it MUST NOT
   * affect any node/edge content hash and MUST NOT silently alter
   * extraction behavior; it only makes an assessment that already gates
   * the pipeline (see `@xo/compiler`'s `document-quality.ts`) inspectable
   * downstream, including after the graph is serialized and reloaded
   * independently of the original compile call. Absent for graphs whose
   * compiler never assessed source quality (all schema-version-1 graphs,
   * and any non-document-derived graph, e.g. hand-built XOIR in tests).
   */
  readonly sourceQuality?: Readonly<Record<string, SourceQualityInfo>>;
}

/**
 * One source's extraction-quality assessment, mirroring (structurally,
 * not by import — `@xo/xoir` must not depend on `@xo/compiler`)
 * `@xo/compiler`'s `document-quality.ts#SourceQualityState`/
 * `DocumentQualityReport`. `'trusted'` and `'degraded'` sources both
 * contribute units to the graph (a `'blocked'` source, by definition,
 * never does — so `'blocked'` should not actually appear here in
 * practice, but is listed for completeness/forward-compatibility rather
 * than assumed away).
 */
export interface SourceQualityInfo {
  readonly state: 'trusted' | 'degraded' | 'blocked';
  /** Same metric `document-quality.ts#DocumentQualityReport.suspiciousTokenRatio` reports — the fraction of tokens that looked like layout-reconstruction artifacts rather than real words. */
  readonly suspiciousTokenRatio: number;
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
  readonly timestamp: string; // ISO-8601
  readonly summary?: string;
}

export interface CreateManifestInput {
  readonly schemaVersion: number;
  readonly compilerVersion?: string;
  readonly professionTags?: readonly string[];
  readonly sourceManifestRefs?: readonly string[];
  readonly passHistory?: readonly PassHistoryEntry[];
  readonly graphHash?: ContentHash;
  readonly sourceQuality?: Readonly<Record<string, SourceQualityInfo>>;
  readonly now?: () => string;
}

export function createManifest(input: CreateManifestInput): XoirManifest {
  return {
    schemaVersion: input.schemaVersion,
    ...(input.compilerVersion !== undefined ? { compilerVersion: input.compilerVersion } : {}),
    professionTags: input.professionTags ?? [],
    sourceManifestRefs: input.sourceManifestRefs ?? [],
    passHistory: input.passHistory ?? [],
    ...(input.graphHash !== undefined ? { graphHash: input.graphHash } : {}),
    ...(input.sourceQuality !== undefined ? { sourceQuality: input.sourceQuality } : {}),
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

/** Returns a new manifest with one more `PassHistoryEntry` appended — manifests are treated as immutable values, same convention as `XoirNode`/`XoirEdge`. */
export function appendPassHistory(manifest: XoirManifest, entry: PassHistoryEntry): XoirManifest {
  return { ...manifest, passHistory: [...manifest.passHistory, entry] };
}

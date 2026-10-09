/**
 * Explicit migration mapping from every legacy kind to its canonical
 * successor, per the reconciliation report §15. `undefined` means the
 * legacy kind doesn't correspond to a *semantic* XOIR node at all — it
 * belongs to the package/manifest/registry layer (see the doc comment on
 * {@link LegacyXoirNodeKind} for exactly where each one now lives).
 * `'knowledge'`, `'case_study'`, and `'benchmark'` have no single
 * unambiguous target (content-dependent), so a caller migrating one of
 * those must inspect `properties`/`subtype` itself — this map only
 * documents the *set* of valid destinations via the comment above; the
 * mapping table below encodes only the unambiguous, mechanical cases.
 */
export const LEGACY_NODE_KIND_MIGRATION = {
    knowledge: undefined, // ambiguous — see doc comment; use migrateKnowledgeKind-style content inspection at the call site
    reasoning: 'reasoning_step',
    decision: 'decision_node',
    memory: 'memory_unit',
    evaluation: 'evaluation_artifact',
    benchmark: 'evaluation_artifact',
    prompt_strategy: undefined,
    case_study: undefined, // ambiguous — see doc comment
    metadata: undefined,
    provenance: undefined,
    license: undefined,
    identity: undefined,
    version: undefined,
};
export function isLegacyNodeKind(kind) {
    return Object.prototype.hasOwnProperty.call(LEGACY_NODE_KIND_MIGRATION, kind);
}
/** Mechanically migrates a legacy node's `kind`, where the mapping is unambiguous. Returns `undefined` for kinds with no single canonical target (see {@link LEGACY_NODE_KIND_MIGRATION}) or that aren't legacy at all. */
export function migrateLegacyNodeKind(kind) {
    return LEGACY_NODE_KIND_MIGRATION[kind];
}
/**
 * Builds a node with its metadata defaults filled in. Does NOT compute
 * `hash` — that's `hashing.ts#hashNode`'s job, since hashing needs to see
 * the fully-assembled node (hashing a node while building it would hash a
 * moving target). `graph.ts#XoirGraph.addNode` is the one call site that
 * chains `createNode` -> `hashNode` -> stores the result, so a node never
 * exists inside a graph without a hash.
 */
export function createNode(input) {
    const now = input.now ?? (() => new Date().toISOString());
    const timestamp = now();
    const confidence = input.confidence ?? input.confidenceDetail?.score ?? 1;
    return {
        id: input.id,
        kind: input.kind,
        properties: input.properties,
        version: input.version ?? 1,
        metadata: {
            confidence,
            ...(input.confidenceDetail ? { confidenceDetail: input.confidenceDetail } : {}),
            sourceRefs: input.sourceRefs ?? [],
            tags: input.tags ?? [],
            createdAt: timestamp,
            updatedAt: timestamp,
            custom: input.custom ?? {},
            ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
        },
    };
}
//# sourceMappingURL=node-kinds.js.map
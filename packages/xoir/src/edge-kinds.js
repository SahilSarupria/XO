export function isCoreXoirEdgeKind(kind) {
    return (kind === 'REQUIRES' ||
        kind === 'CONTRADICTS' ||
        kind === 'SUPPORTS' ||
        kind === 'REFINES' ||
        kind === 'SUPERSEDES' ||
        kind === 'ESCALATES_TO' ||
        kind === 'TRIGGERED_BY' ||
        kind === 'CO_OCCURS_WITH' ||
        kind === 'DERIVED_FROM' ||
        kind === 'COMPOSES_INTO');
}
/** Builds an edge with metadata defaults filled in. As with {@link createNode}, hashing happens separately (hashing.ts#hashEdge), applied by `graph.ts#XoirGraph.addEdge`. */
export function createEdge(input) {
    const now = input.now ?? (() => new Date().toISOString());
    const confidence = input.confidence ?? input.confidenceDetail?.score ?? 1;
    const base = {
        id: input.id,
        kind: input.kind,
        fromId: input.fromId,
        toId: input.toId,
        properties: (input.properties ?? {}),
        metadata: {
            confidence,
            ...(input.confidenceDetail ? { confidenceDetail: input.confidenceDetail } : {}),
            sourceRefs: input.sourceRefs ?? [],
            tags: input.tags ?? [],
            createdAt: now(),
            custom: input.custom ?? {},
        },
    };
    return input.weight !== undefined ? { ...base, weight: input.weight } : base;
}
//# sourceMappingURL=edge-kinds.js.map
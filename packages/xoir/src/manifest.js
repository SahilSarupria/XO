export function createManifest(input) {
    return {
        schemaVersion: input.schemaVersion,
        ...(input.compilerVersion !== undefined ? { compilerVersion: input.compilerVersion } : {}),
        professionTags: input.professionTags ?? [],
        sourceManifestRefs: input.sourceManifestRefs ?? [],
        passHistory: input.passHistory ?? [],
        ...(input.graphHash !== undefined ? { graphHash: input.graphHash } : {}),
        createdAt: (input.now ?? (() => new Date().toISOString()))(),
    };
}
/** Returns a new manifest with one more `PassHistoryEntry` appended — manifests are treated as immutable values, same convention as `XoirNode`/`XoirEdge`. */
export function appendPassHistory(manifest, entry) {
    return { ...manifest, passHistory: [...manifest.passHistory, entry] };
}
//# sourceMappingURL=manifest.js.map
import { err, ok } from '@xo/types';
import { InvalidArgumentError, XoirError, ErrorCode } from '@xo/errors';
import { canonicalStringify, hashNode, hashEdge } from './hashing.js';
import { XoirGraph } from './graph.js';
import { confidenceFromScore, evidenceStrengthFromCorroboration } from './confidence.js';
import { resolveConflict } from './merge.js';
import { createManifest } from './manifest.js';
function byIdAsc(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function groupByCoreEquality(candidates, keyOf) {
    const groups = new Map();
    for (const c of candidates) {
        const key = keyOf(c);
        const list = groups.get(key) ?? [];
        list.push(c);
        groups.set(key, list);
    }
    return [...groups.values()];
}
function nodeCoreKey(node) {
    return canonicalStringify({
        kind: node.kind,
        subtype: node.metadata.subtype ?? null,
        properties: node.properties,
        custom: node.metadata.custom,
    });
}
function edgeCoreKey(edge) {
    return canonicalStringify({
        kind: edge.kind,
        fromId: edge.fromId,
        toId: edge.toId,
        weight: edge.weight ?? null,
        properties: edge.properties,
        custom: edge.metadata.custom,
    });
}
function unionSourceRefs(groups) {
    const seen = new Map();
    for (const refs of groups) {
        for (const ref of refs) {
            seen.set(canonicalStringify(ref), ref);
        }
    }
    // Sorted by canonical content (not encounter order) so the union is independent of which input
    // graph came first — two merges of the same graph *set* in a different array order must agree.
    return [...seen.entries()].sort((a, b) => byIdAsc(a[0], b[0])).map(([, ref]) => ref);
}
function unionTags(groups) {
    return [...new Set(groups.flat())].sort();
}
function reconcileConfidence(candidates, corroboration) {
    const bestScore = Math.max(...candidates.map((c) => c.metadata.confidenceDetail?.score ?? c.metadata.confidence));
    const bases = new Set(candidates.map((c) => c.metadata.confidenceDetail?.basis ?? 'unknown'));
    const allCalibrated = candidates.every((c) => c.metadata.confidenceDetail?.calibrated === true);
    return confidenceFromScore(bestScore, {
        basis: bases.size === 1 ? [...bases][0] : 'hybrid_extraction',
        evidenceStrength: evidenceStrengthFromCorroboration(corroboration),
        corroboration,
        calibrated: allCalibrated,
    });
}
function reconcileNodeGroup(group, now) {
    const base = group[0];
    const sourceRefs = unionSourceRefs(group.map((n) => n.metadata.sourceRefs));
    const tags = unionTags(group.map((n) => n.metadata.tags));
    const confidenceDetail = reconcileConfidence(group, sourceRefs.length);
    const earliestCreatedAt = [...group.map((n) => n.metadata.createdAt)].sort()[0];
    const highestVersion = Math.max(...group.map((n) => n.version));
    const withoutHash = {
        id: base.id,
        kind: base.kind,
        properties: base.properties,
        version: highestVersion,
        metadata: {
            confidence: confidenceDetail.score,
            confidenceDetail,
            sourceRefs,
            tags,
            createdAt: earliestCreatedAt,
            updatedAt: now(),
            custom: base.metadata.custom,
            ...(base.metadata.subtype !== undefined ? { subtype: base.metadata.subtype } : {}),
        },
    };
    return { ...withoutHash, hash: hashNode(withoutHash) };
}
function reconcileEdgeGroup(group, now) {
    const base = group[0];
    const sourceRefs = unionSourceRefs(group.map((e) => e.metadata.sourceRefs));
    const tags = unionTags(group.map((e) => e.metadata.tags));
    const confidenceDetail = reconcileConfidence(group, sourceRefs.length);
    const withoutHash = {
        id: base.id,
        kind: base.kind,
        fromId: base.fromId,
        toId: base.toId,
        properties: base.properties,
        ...(base.weight !== undefined ? { weight: base.weight } : {}),
        metadata: {
            confidence: confidenceDetail.score,
            confidenceDetail,
            sourceRefs,
            tags,
            createdAt: [...group.map((e) => e.metadata.createdAt)].sort()[0],
            custom: base.metadata.custom,
        },
    };
    return { ...withoutHash, hash: hashEdge(withoutHash) };
}
function mergeManifests(graphs, now) {
    const manifests = graphs.map((g) => g.manifest).filter((m) => m !== undefined);
    if (manifests.length === 0)
        return undefined;
    const professionTags = [...new Set(manifests.flatMap((m) => m.professionTags))].sort();
    const sourceManifestRefs = [...new Set(manifests.flatMap((m) => m.sourceManifestRefs))].sort();
    const passHistory = manifests
        .flatMap((m) => m.passHistory)
        .slice()
        .sort((a, b) => (a.timestamp === b.timestamp ? byIdAsc(a.passId, b.passId) : byIdAsc(a.timestamp, b.timestamp)));
    const compilerVersion = manifests.find((m) => m.compilerVersion !== undefined)?.compilerVersion;
    return createManifest({
        schemaVersion: Math.max(...manifests.map((m) => m.schemaVersion)),
        ...(compilerVersion !== undefined ? { compilerVersion } : {}),
        professionTags,
        sourceManifestRefs,
        passHistory,
        now,
    });
}
/**
 * Combines multiple XOIR graphs the way `merge.ts#mergeGraphs` does
 * (identity-preserving by `id`, id conflicts reported and resolved by
 * `strategy`), but with one deliberate difference: before treating two
 * same-id candidates as a conflict, it checks whether they actually agree
 * on *core* content (`kind`, `metadata.subtype`, `properties`,
 * `metadata.custom` for nodes; `kind`/`fromId`/`toId`/`weight`/
 * `properties`/`metadata.custom` for edges). If they do, they are not a
 * conflict at all — they are the same claim corroborated by more than one
 * source, and are reconciled into a single node/edge whose `sourceRefs`/
 * `tags` are the union of every candidate's (deduplicated by content) and
 * whose `confidenceDetail` reflects the real, larger corroboration count.
 * Nothing is picked-and-discarded in that case, satisfying the Stage 5.5
 * rule that provenance is additive, never overwritten.
 *
 * Only candidates whose *core* content genuinely differs fall through to
 * `merge.ts#mergeGraphs`'s existing conflict-resolution policy
 * (`resolveConflict`, reused verbatim here, not reimplemented) — this
 * function does not invent new conflict-resolution semantics, only a
 * pre-step that shrinks how often "conflict" is the right word for what
 * is actually corroboration. Edge conflicts follow the identical
 * decide-then-resolve shape, reported separately (`edgeConflicts`) since
 * `MergeConflict` from `merge.ts` is node-shaped.
 *
 * Manifests are combined too — see `mergeManifests` — rather than the
 * "never looked at" behavior `merge.ts#mergeGraphs` has (it predates
 * manifests being something a merge needs to combine).
 */
export function mergeGraphsPreservingProvenance(graphs, newGraphId, options = {}) {
    if (graphs.length === 0) {
        return err(new InvalidArgumentError('mergeGraphsPreservingProvenance requires at least one graph'));
    }
    const strategy = options.strategy ?? 'prefer_higher_confidence';
    const now = options.now ?? (() => new Date().toISOString());
    const merged = new XoirGraph(newGraphId, graphs[0].schemaVersion, mergeManifests(graphs, now));
    const conflicts = [];
    const edgeConflicts = [];
    const reconciledNodeIds = [];
    const reconciledEdgeIds = [];
    const nodesById = new Map();
    for (const graph of graphs) {
        for (const node of graph.allNodes()) {
            const list = nodesById.get(node.id) ?? [];
            list.push(node);
            nodesById.set(node.id, list);
        }
    }
    for (const [id, candidates] of [...nodesById.entries()].sort((a, b) => byIdAsc(a[0], b[0]))) {
        const classes = groupByCoreEquality(candidates, nodeCoreKey);
        if (classes.length === 1) {
            const group = classes[0];
            const reconciled = group.length > 1 ? reconcileNodeGroup(group, now) : group[0];
            if (group.length > 1)
                reconciledNodeIds.push(id);
            const added = merged.addNode(reconciled);
            if (!added.ok)
                return err(added.error);
            continue;
        }
        const classRepresentatives = classes.map((cls) => (cls.length > 1 ? reconcileNodeGroup(cls, now) : cls[0]));
        const resolution = resolveConflict(classRepresentatives, strategy);
        conflicts.push({ nodeId: id, reason: 'duplicate_id_different_content', candidates: classRepresentatives, resolution });
        if (resolution === undefined) {
            return err(new XoirError(ErrorCode.XOIR_MERGE_CONFLICT, `Unresolved node conflict for "${id}" under strategy "error_on_conflict"`));
        }
        const added = merged.addNode(resolution);
        if (!added.ok)
            return err(added.error);
    }
    const edgesById = new Map();
    for (const graph of graphs) {
        for (const edge of graph.allEdges()) {
            const list = edgesById.get(edge.id) ?? [];
            list.push(edge);
            edgesById.set(edge.id, list);
        }
    }
    for (const [id, candidates] of [...edgesById.entries()].sort((a, b) => byIdAsc(a[0], b[0]))) {
        if (!merged.hasNode(candidates[0].fromId) || !merged.hasNode(candidates[0].toId))
            continue;
        const classes = groupByCoreEquality(candidates, edgeCoreKey);
        if (classes.length === 1) {
            const group = classes[0];
            const reconciled = group.length > 1 ? reconcileEdgeGroup(group, now) : group[0];
            if (group.length > 1)
                reconciledEdgeIds.push(id);
            const added = merged.addEdge(reconciled);
            if (!added.ok)
                return err(added.error);
            continue;
        }
        const classRepresentatives = classes.map((cls) => (cls.length > 1 ? reconcileEdgeGroup(cls, now) : cls[0]));
        const resolvedEdge = resolveEdgeConflict(classRepresentatives, strategy);
        edgeConflicts.push({ edgeId: id, candidates: classRepresentatives, resolution: resolvedEdge });
        if (resolvedEdge === undefined) {
            return err(new XoirError(ErrorCode.XOIR_MERGE_CONFLICT, `Unresolved edge conflict for "${id}" under strategy "error_on_conflict"`));
        }
        const added = merged.addEdge(resolvedEdge);
        if (!added.ok)
            return err(added.error);
    }
    return ok({ graph: merged, conflicts, edgeConflicts, reconciledNodeIds, reconciledEdgeIds });
}
function resolveEdgeConflict(candidates, strategy) {
    switch (strategy) {
        case 'prefer_first':
            return candidates[0];
        case 'prefer_last':
            return candidates[candidates.length - 1];
        case 'prefer_higher_confidence':
            return [...candidates].sort((a, b) => b.metadata.confidence - a.metadata.confidence)[0];
        case 'error_on_conflict':
            return undefined;
    }
}
//# sourceMappingURL=provenance-merge.js.map
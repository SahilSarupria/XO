import { canonicalStringify } from './hashing.js';
function shallowPropertyDiff(before, after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes = [];
    for (const key of keys) {
        const b = before[key];
        const a = after[key];
        if (canonicalStringify(b ?? null) !== canonicalStringify(a ?? null)) {
            changes.push({ path: key, before: b, after: a });
        }
    }
    return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
/**
 * Structural diff between two XOIR graphs, keyed by node/edge `id` — this
 * is an *identity-preserving* diff (SPECIFICATION.md's "Version
 * differences") in the same sense merge.ts's conflict detection is: a node
 * that changed content but kept its id is "modified", not "removed then
 * added". Two nodes with different ids are never matched to each other
 * even if their content is identical — that's a merge/dedup concern
 * (merge.ts), not a diff concern.
 */
export function diffGraphs(before, after) {
    const beforeNodes = new Map(before.allNodes().map((n) => [n.id, n]));
    const afterNodes = new Map(after.allNodes().map((n) => [n.id, n]));
    const addedNodes = [];
    const removedNodes = [];
    const modifiedNodes = [];
    for (const [id, afterNode] of afterNodes) {
        const beforeNode = beforeNodes.get(id);
        if (!beforeNode) {
            addedNodes.push(afterNode);
            continue;
        }
        if (beforeNode.hash !== afterNode.hash) {
            modifiedNodes.push({
                id,
                before: beforeNode,
                after: afterNode,
                propertyChanges: shallowPropertyDiff(beforeNode.properties, afterNode.properties),
                versionDelta: afterNode.version - beforeNode.version,
            });
        }
    }
    for (const [id, beforeNode] of beforeNodes) {
        if (!afterNodes.has(id))
            removedNodes.push(beforeNode);
    }
    const beforeEdges = new Map(before.allEdges().map((e) => [e.id, e]));
    const afterEdges = new Map(after.allEdges().map((e) => [e.id, e]));
    const addedEdges = [...afterEdges.values()].filter((e) => !beforeEdges.has(e.id));
    const removedEdges = [...beforeEdges.values()].filter((e) => !afterEdges.has(e.id));
    return {
        addedNodes: addedNodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
        removedNodes: removedNodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
        modifiedNodes: modifiedNodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
        addedEdges: addedEdges.sort((a, b) => (a.id < b.id ? -1 : 1)),
        removedEdges: removedEdges.sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
}
/** Renders a {@link GraphDiff} as a human-readable, git-diff-flavored report. */
export function formatDiff(diff) {
    const lines = [];
    for (const n of diff.addedNodes)
        lines.push(`+ node ${n.id} (${n.kind})`);
    for (const n of diff.removedNodes)
        lines.push(`- node ${n.id} (${n.kind})`);
    for (const m of diff.modifiedNodes) {
        lines.push(`~ node ${m.id} (v${m.before.version} -> v${m.after.version})`);
        for (const change of m.propertyChanges) {
            lines.push(`    ${change.path}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
        }
    }
    for (const e of diff.addedEdges)
        lines.push(`+ edge ${e.id} (${e.kind}: ${e.fromId} -> ${e.toId})`);
    for (const e of diff.removedEdges)
        lines.push(`- edge ${e.id} (${e.kind}: ${e.fromId} -> ${e.toId})`);
    return lines.length > 0 ? lines.join('\n') : '(no differences)';
}
//# sourceMappingURL=diff.js.map
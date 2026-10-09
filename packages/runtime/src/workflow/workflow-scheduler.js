import { edgeKey } from './workflow-state.js';
function nodeIndex(graph) {
    const index = new Map();
    graph.nodes.forEach((node, i) => index.set(node.id, i));
    return index;
}
function incomingEdgesByTarget(graph) {
    const byTarget = new Map();
    for (const edge of graph.edges) {
        const bucket = byTarget.get(edge.to);
        if (bucket)
            bucket.push(edge);
        else
            byTarget.set(edge.to, [edge]);
    }
    return byTarget;
}
function classifyIncomingEdge(edge, state) {
    if (state.failedNodes.includes(edge.from))
        return 'failed';
    if (state.skippedNodes.includes(edge.from))
        return 'skipped';
    if (state.completedNodes.includes(edge.from)) {
        // The source completed, but this specific edge is only "completed"
        // for readiness purposes if it was actually taken (see
        // `WorkflowState.takenEdges`'s doc comment) — an untaken edge out of
        // a completed `decision`/`loop` node is treated exactly like an edge
        // from a `skipped` source, so its target doesn't incorrectly become
        // ready.
        return state.takenEdges.includes(edgeKey(edge.from, edge.to)) ? 'completed' : 'skipped';
    }
    return 'pending';
}
/**
 * Deterministic scheduling for a directed `WorkflowGraph` — "execution
 * order must always be reproducible; no randomness; no dependency on
 * object iteration order." Every method here is a pure function of its
 * arguments; `WorkflowScheduler` itself holds no state.
 *
 * The one readiness rule below is deliberately generic rather than
 * special-cased per node type — it's what makes `sequence` (single
 * predecessor, must be completed), parallel fan-out (multiple
 * simultaneously-ready nodes, no special rule needed), an AND-join at an
 * explicit `merge` node (multiple predecessors, all must be terminal),
 * and an OR-join at an ordinary reconvergence node after a `decision`
 * (multiple predecessors, but only the taken branch actually completes —
 * the rest resolve to `skipped`) all fall out of the same rule, with
 * `merge`/`sequence` staying pure documentation/semantic markers rather
 * than scheduler-special-cased behavior. See `packages/runtime/README.md`'s
 * Stage 3 section for the full walkthrough with an example graph.
 */
export class WorkflowScheduler {
    computeCursor(graph, state) {
        const visited = new Set([...state.completedNodes, ...state.failedNodes, ...state.skippedNodes]);
        const incoming = incomingEdgesByTarget(graph);
        const index = nodeIndex(graph);
        const ready = [];
        const toSkip = [];
        const waiting = [];
        for (const node of graph.nodes) {
            if (visited.has(node.id))
                continue;
            const predecessors = incoming.get(node.id) ?? [];
            if (predecessors.length === 0) {
                // No incoming edges: only the declared start node is reachable
                // this way; anything else with no predecessors and not the
                // start node is unreachable by construction and simply never
                // resolves (surfaced, if it matters, by a caller inspecting
                // `waiting` once the workflow otherwise terminates — this
                // scheduler doesn't itself validate graph well-formedness).
                if (node.id === graph.startNodeId)
                    ready.push(node.id);
                continue;
            }
            const resolved = predecessors.map((edge) => classifyIncomingEdge(edge, state));
            if (resolved.some((status) => status === 'pending')) {
                waiting.push(node.id);
                continue;
            }
            if (resolved.some((status) => status === 'completed')) {
                ready.push(node.id);
            }
            else {
                // every predecessor terminal, none completed -> every live path
                // into this node was skipped (or failed with no other route in)
                toSkip.push(node.id);
            }
        }
        const byDeclarationOrder = (a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0);
        return Object.freeze({
            ready: ready.sort(byDeclarationOrder),
            toSkip: toSkip.sort(byDeclarationOrder),
            waiting: waiting.sort(byDeclarationOrder),
        });
    }
    /** Every outgoing edge of `node`, in `graph.edges`' declared order — the order `decision`/`loop` handlers evaluate conditions in. */
    outgoingEdges(graph, nodeId) {
        return graph.edges.filter((edge) => edge.from === nodeId);
    }
    nodeById(graph, nodeId) {
        return graph.nodes.find((node) => node.id === nodeId);
    }
}
//# sourceMappingURL=workflow-scheduler.js.map
import type { NodeId, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.js';
import type { WorkflowState } from './workflow-state.js';
import { edgeKey } from './workflow-state.js';

/**
 * The deterministic execution frontier: which nodes are ready to
 * dispatch right now, and which are still waiting on incomplete
 * predecessors. Computed fresh from `WorkflowGraph` + `WorkflowState` on
 * every round — never itself mutated or cached across rounds, so it can
 * never drift from the state it was computed against.
 */
export interface WorkflowCursor {
  /** Nodes with every incoming edge's source already terminal (completed/failed/skipped) and at least one `completed` — ready to execute this round. Sorted by each node's index in `graph.nodes` (declaration order), never by `Map`/`Set` iteration or arrival order — see the module doc comment for why that matters. */
  readonly ready: readonly NodeId[];
  /** Nodes with every incoming edge's source terminal, but *none* `completed` (every live path into them was `skipped`) — resolve to `skipped` on the same round, without ever being dispatched to a handler. Same declaration-order sorting as `ready`. */
  readonly toSkip: readonly NodeId[];
  /** Everything else not yet visited: still has at least one incoming edge whose source hasn't reached a terminal state yet. */
  readonly waiting: readonly NodeId[];
}

function nodeIndex(graph: WorkflowGraph): ReadonlyMap<NodeId, number> {
  const index = new Map<NodeId, number>();
  graph.nodes.forEach((node, i) => index.set(node.id, i));
  return index;
}

function incomingEdgesByTarget(graph: WorkflowGraph): ReadonlyMap<NodeId, readonly WorkflowEdge[]> {
  const byTarget = new Map<NodeId, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    const bucket = byTarget.get(edge.to);
    if (bucket) bucket.push(edge);
    else byTarget.set(edge.to, [edge]);
  }
  return byTarget;
}

function classifyIncomingEdge(edge: WorkflowEdge, state: WorkflowState): 'completed' | 'failed' | 'skipped' | 'pending' {
  if (state.failedNodes.includes(edge.from)) return 'failed';
  if (state.skippedNodes.includes(edge.from)) return 'skipped';
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
  computeCursor(graph: WorkflowGraph, state: WorkflowState): WorkflowCursor {
    const visited = new Set<NodeId>([...state.completedNodes, ...state.failedNodes, ...state.skippedNodes]);
    const incoming = incomingEdgesByTarget(graph);
    const index = nodeIndex(graph);

    const ready: NodeId[] = [];
    const toSkip: NodeId[] = [];
    const waiting: NodeId[] = [];

    for (const node of graph.nodes) {
      if (visited.has(node.id)) continue;

      const predecessors = incoming.get(node.id) ?? [];
      if (predecessors.length === 0) {
        // No incoming edges: only the declared start node is reachable
        // this way; anything else with no predecessors and not the
        // start node is unreachable by construction and simply never
        // resolves (surfaced, if it matters, by a caller inspecting
        // `waiting` once the workflow otherwise terminates — this
        // scheduler doesn't itself validate graph well-formedness).
        if (node.id === graph.startNodeId) ready.push(node.id);
        continue;
      }

      const resolved = predecessors.map((edge) => classifyIncomingEdge(edge, state));
      if (resolved.some((status) => status === 'pending')) {
        waiting.push(node.id);
        continue;
      }
      if (resolved.some((status) => status === 'completed')) {
        ready.push(node.id);
      } else {
        // every predecessor terminal, none completed -> every live path
        // into this node was skipped (or failed with no other route in)
        toSkip.push(node.id);
      }
    }

    const byDeclarationOrder = (a: NodeId, b: NodeId): number => (index.get(a) ?? 0) - (index.get(b) ?? 0);
    return Object.freeze({
      ready: ready.sort(byDeclarationOrder),
      toSkip: toSkip.sort(byDeclarationOrder),
      waiting: waiting.sort(byDeclarationOrder),
    });
  }

  /** Every outgoing edge of `node`, in `graph.edges`' declared order — the order `decision`/`loop` handlers evaluate conditions in. */
  outgoingEdges(graph: WorkflowGraph, nodeId: NodeId): readonly WorkflowEdge[] {
    return graph.edges.filter((edge) => edge.from === nodeId);
  }

  nodeById(graph: WorkflowGraph, nodeId: NodeId): WorkflowNode | undefined {
    return graph.nodes.find((node) => node.id === nodeId);
  }
}

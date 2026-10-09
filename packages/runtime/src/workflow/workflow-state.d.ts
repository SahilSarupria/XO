import type { NodeId } from './workflow-graph.js';
/** `` `${from}::${to}` `` — the edge-key format `WorkflowState.takenEdges` uses. Node ids are expected to be simple identifiers without `::` in them; see `WorkflowState.takenEdges`'s doc comment. */
export declare function edgeKey(from: NodeId, to: NodeId): string;
export type WorkflowNodeStatus = 'completed' | 'failed' | 'skipped';
export interface WorkflowHistoryEntry {
    readonly nodeId: NodeId;
    readonly status: WorkflowNodeStatus;
    readonly attempt: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly error?: string;
}
/** Aggregated across every `capability` node the workflow has executed (via `ExecutionPipeline`, reused unmodified — see `WorkflowExecutor`'s doc comment). */
export interface WorkflowResourceUsage {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly estimatedCost: number;
}
export declare const EMPTY_RESOURCE_USAGE: WorkflowResourceUsage;
/**
 * Immutable workflow execution state — the workflow-level analogue of
 * Stage 1/2's `PackageRegistry`/`ExecutionSession`: every mutation
 * (`WorkflowScheduler`'s advancement functions) returns a *new*
 * `WorkflowState`, nothing here is ever mutated in place.
 */
export interface WorkflowState {
    /** Nodes currently dispatched and awaiting completion — set only mid-round, empty between rounds and once the workflow reaches a terminal state. */
    readonly currentNodeIds: readonly NodeId[];
    readonly completedNodes: readonly NodeId[];
    readonly failedNodes: readonly NodeId[];
    readonly skippedNodes: readonly NodeId[];
    /** Every completed node's output, keyed by `NodeId`. A `decision`/`loop` node's evaluated condition doesn't produce an output entry; only nodes with actual results (chiefly `capability`, `subworkflow`, `delay`) do. */
    readonly outputs: Readonly<Record<string, unknown>>;
    readonly history: readonly WorkflowHistoryEntry[];
    /**
     * Edge keys (`` `${from}::${to}` ``) actually traversed. For most node
     * types every outgoing edge is taken as soon as the node completes
     * (`WorkflowExecutor` registers them all); for `decision`/`loop`
     * nodes, only the one selected edge is registered. `WorkflowScheduler`
     * treats an edge whose source completed but wasn't taken the same as
     * an edge from a `skipped` source — this is what makes an untaken
     * `decision` branch's target resolve to `skipped` instead of
     * incorrectly becoming ready.
     */
    readonly takenEdges: readonly string[];
    /** Per-`loop`-node visit counters (keyed by `NodeId`) — how `WorkflowScheduler`/`WorkflowExecutor` enforce a loop's `maxIterations` termination guard without needing a separate state-tracking mechanism per loop. Absent entries mean "never visited", equivalent to 0. */
    readonly loopIterations: Readonly<Record<string, number>>;
    readonly resourceUsage: WorkflowResourceUsage;
    readonly startedAt: string;
    readonly updatedAt: string;
}
export declare function createInitialState(now: () => Date): WorkflowState;
//# sourceMappingURL=workflow-state.d.ts.map
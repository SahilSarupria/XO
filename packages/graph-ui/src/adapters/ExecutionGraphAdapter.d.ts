import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { ExecutionNodeStatus, GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface ExecutionGraphNode {
    readonly id: string;
    readonly label: string;
    readonly kind?: string;
    readonly metadata?: GraphMetadata;
}
export interface ExecutionGraphEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly label?: string;
    readonly metadata?: GraphMetadata;
}
export interface ExecutionGraphSource {
    readonly nodes: readonly ExecutionGraphNode[];
    readonly edges: readonly ExecutionGraphEdge[];
    /** Optional initial per-node execution status, e.g. from a runtime
     * snapshot. graph-ui only consumes this as plain data — it never reaches
     * into the runtime itself. */
    readonly statuses?: Readonly<Record<string, ExecutionNodeStatus>>;
}
/** Converts a runtime-debugger-style execution graph into a generic GraphModel. */
export declare const ExecutionGraphAdapter: GraphAdapter<ExecutionGraphSource>;
/** Builds the initial GraphExecutionState implied by a source's `statuses` map. */
export declare function executionStateFromSource(source: ExecutionGraphSource): GraphExecutionState;
//# sourceMappingURL=ExecutionGraphAdapter.d.ts.map
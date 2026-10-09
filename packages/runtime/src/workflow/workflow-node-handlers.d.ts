import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import type { WorkflowContext } from './workflow-context.js';
import type { NodeId, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.js';
import type { WorkflowNodeReceipt } from './workflow-receipt.js';
/** What a `NodeHandler` produces for one node execution. */
export interface NodeHandlerResult {
    /** Stored at `state.outputs[node.id]` on success. Absent for purely structural nodes (`start`, `sequence`, `parallel`, `merge`). */
    readonly output?: unknown;
    /** Edges from this node that were actually taken — see `WorkflowState.takenEdges`. Absent means "every outgoing edge" (the default for every node type except `decision`/`loop`, which always set this explicitly, even if empty). */
    readonly takenEdges?: readonly WorkflowEdge[];
    readonly nodeReceipts?: readonly WorkflowNodeReceipt[];
    readonly resourceUsage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly estimatedCost?: number;
    };
}
export type NodeHandler = (node: WorkflowNode, context: WorkflowContext) => Promise<Result<NodeHandlerResult, RuntimeError>>;
/**
 * Runs a `capability` node by delegating entirely to Stage 2's own
 * `ExecutionPipeline.run` — building a synthetic per-node
 * `ExecutionRequest` from the node's `config` and calling straight back
 * into the *same* pipeline instance that's running the workflow, with no
 * `workflowGraph` on the synthetic request (so it takes Stage 2's
 * unmodified, un-branched code path). This is the entire integration
 * surface between Stage 3 and Stage 2/`@xo/ai-core`: zero duplicated
 * negotiation/retrieval/context/prompt/AI-call logic, and zero
 * modification to how any of that already works.
 */
export declare function makeCapabilityNodeHandler(runCapability: (request: ExecutionRequest, cancellation: WorkflowContext['cancellation']) => Promise<ExecutionResult>): NodeHandler;
export interface BuiltinHandlerDeps {
    readonly scheduler: {
        outgoingEdges: (graph: WorkflowGraph, nodeId: NodeId) => readonly WorkflowEdge[];
    };
    readonly runCapability: (request: ExecutionRequest, cancellation: WorkflowContext['cancellation']) => Promise<ExecutionResult>;
    readonly runNestedGraph: (graph: WorkflowGraph, context: WorkflowContext, outputs: Readonly<Record<string, unknown>>) => Promise<Result<{
        outputs: Readonly<Record<string, unknown>>;
        nodeReceipts: readonly WorkflowNodeReceipt[];
        resourceUsage: NodeHandlerResult['resourceUsage'];
    }, RuntimeError>>;
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}
export declare function builtinNodeHandlers(deps: BuiltinHandlerDeps): ReadonlyMap<string, NodeHandler>;
//# sourceMappingURL=workflow-node-handlers.d.ts.map
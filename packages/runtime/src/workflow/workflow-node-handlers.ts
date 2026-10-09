import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import { RequestId } from '../ids.js';
import type { WorkflowContext } from './workflow-context.js';
import { evaluateCondition } from './workflow-condition.js';
import type { NodeId, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.js';
import type { WorkflowNodeReceipt } from './workflow-receipt.js';

/** What a `NodeHandler` produces for one node execution. */
export interface NodeHandlerResult {
  /** Stored at `state.outputs[node.id]` on success. Absent for purely structural nodes (`start`, `sequence`, `parallel`, `merge`). */
  readonly output?: unknown;
  /** Edges from this node that were actually taken — see `WorkflowState.takenEdges`. Absent means "every outgoing edge" (the default for every node type except `decision`/`loop`, which always set this explicitly, even if empty). */
  readonly takenEdges?: readonly WorkflowEdge[];
  readonly nodeReceipts?: readonly WorkflowNodeReceipt[];
  readonly resourceUsage?: { readonly promptTokens?: number; readonly completionTokens?: number; readonly estimatedCost?: number };
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
export function makeCapabilityNodeHandler(runCapability: (request: ExecutionRequest, cancellation: WorkflowContext['cancellation']) => Promise<ExecutionResult>): NodeHandler {
  return async (node, context) => {
    const config = node.config ?? {};
    const capabilityId = typeof config.capabilityId === 'string' ? config.capabilityId : undefined;
    if (!capabilityId) {
      return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Workflow node "${node.id}" (type "capability") is missing a string "capabilityId" in its config`));
    }
    const input = typeof config.input === 'string' ? config.input : '';
    const auxiliaryCapabilityIds = Array.isArray(config.auxiliaryCapabilityIds) ? (config.auxiliaryCapabilityIds as string[]) : undefined;
    const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : undefined;

    const nodeRequest: ExecutionRequest = {
      requestId: RequestId(`${context.workflowInstanceId}::${node.id}`),
      capabilityId,
      input,
      environment: context.environment,
      requestedAt: new Date().toISOString(),
      ...(auxiliaryCapabilityIds ? { auxiliaryCapabilityIds } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };

    const result = await runCapability(nodeRequest, context.cancellation);
    if (result.error || !result.receipt || !result.response) {
      return err(result.error ?? new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Workflow node "${node.id}" produced no response`));
    }

    return ok({
      output: result.response.content,
      nodeReceipts: [{ nodeId: node.id, receipt: result.receipt }],
      resourceUsage: {
        promptTokens: result.response.usage.promptTokens,
        completionTokens: result.response.usage.completionTokens,
        estimatedCost: result.receipt.estimatedCost?.amount ?? 0,
      },
    });
  };
}

async function structuralHandler(): Promise<Result<NodeHandlerResult, RuntimeError>> {
  return ok({});
}

function decisionHandler(scheduler: { outgoingEdges: (graph: WorkflowGraph, nodeId: NodeId) => readonly WorkflowEdge[] }): NodeHandler {
  return async (node, context) => {
    const edges = scheduler.outgoingEdges(context.graph, node.id);
    const selected = edges.find((edge) => edge.condition === undefined || evaluateCondition(edge.condition, context.state.outputs));
    if (!selected) {
      return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Decision node "${node.id}" had no matching outgoing edge and no default (unconditioned) edge`));
    }
    return ok({ takenEdges: [selected] });
  };
}

const DEFAULT_MAX_LOOP_ITERATIONS = 1000;

/**
 * `loop` runs its `config.bodyGraph` as a nested `WorkflowGraph`,
 * internally, once per iteration, in a plain sequential loop — not by
 * introducing a cycle into the outer graph. `WorkflowScheduler`'s
 * readiness rule (see its own doc comment) assumes a DAG — visiting each
 * outer-graph node once — so looping is modeled as one outer node whose
 * handler happens to take a while and internally repeats, the same way
 * a slow `capability` node "takes a while" from the outer scheduler's
 * perspective. This keeps the outer scheduler simple and fully generic,
 * at the cost of a loop body always being a self-contained subgraph
 * rather than an arbitrary back-edge in the main graph.
 */
function makeLoopHandler(runNestedGraph: (graph: WorkflowGraph, context: WorkflowContext, outputs: Readonly<Record<string, unknown>>) => Promise<Result<{ outputs: Readonly<Record<string, unknown>>; nodeReceipts: readonly WorkflowNodeReceipt[]; resourceUsage: NodeHandlerResult['resourceUsage'] }, RuntimeError>>): NodeHandler {
  return async (node, context) => {
    const config = node.config ?? {};
    const bodyGraph = config.bodyGraph as WorkflowGraph | undefined;
    if (!bodyGraph) {
      return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Loop node "${node.id}" is missing a "bodyGraph" in its config`));
    }
    const maxIterations = typeof config.maxIterations === 'number' ? config.maxIterations : DEFAULT_MAX_LOOP_ITERATIONS;
    const exitCondition = config.exitCondition as import('./workflow-graph.js').WorkflowCondition | undefined;

    let outputs = context.state.outputs;
    const nodeReceipts: WorkflowNodeReceipt[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCost = 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      if (exitCondition && evaluateCondition(exitCondition, outputs)) break;
      if (context.cancellation.isCancelled) break;

      const iterationResult = await runNestedGraph(bodyGraph, context, outputs);
      if (!iterationResult.ok) return iterationResult;

      outputs = { ...outputs, ...iterationResult.value.outputs };
      nodeReceipts.push(...iterationResult.value.nodeReceipts);
      promptTokens += iterationResult.value.resourceUsage?.promptTokens ?? 0;
      completionTokens += iterationResult.value.resourceUsage?.completionTokens ?? 0;
      estimatedCost += iterationResult.value.resourceUsage?.estimatedCost ?? 0;
      iterations += 1;
    }

    return ok({
      output: { iterations, lastOutputs: outputs },
      nodeReceipts,
      resourceUsage: { promptTokens, completionTokens, estimatedCost },
    });
  };
}

function makeDelayHandler(sleep: (ms: number, signal: AbortSignal) => Promise<void>): NodeHandler {
  return async (node, context) => {
    const config = node.config ?? {};
    const durationMs = typeof config.durationMs === 'number' ? config.durationMs : 0;
    await sleep(durationMs, context.cancellation.signal);
    return ok({ output: { delayedMs: durationMs } });
  };
}

function makeSubworkflowHandler(runNestedGraph: (graph: WorkflowGraph, context: WorkflowContext, outputs: Readonly<Record<string, unknown>>) => Promise<Result<{ outputs: Readonly<Record<string, unknown>>; nodeReceipts: readonly WorkflowNodeReceipt[]; resourceUsage: NodeHandlerResult['resourceUsage'] }, RuntimeError>>): NodeHandler {
  return async (node, context) => {
    const config = node.config ?? {};
    const graph = config.graph as WorkflowGraph | undefined;
    if (!graph) {
      return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Subworkflow node "${node.id}" is missing a "graph" in its config`));
    }
    const result = await runNestedGraph(graph, context, context.state.outputs);
    if (!result.ok) return result;
    return ok({ output: result.value.outputs, nodeReceipts: result.value.nodeReceipts, ...(result.value.resourceUsage ? { resourceUsage: result.value.resourceUsage } : {}) });
  };
}

export interface BuiltinHandlerDeps {
  readonly scheduler: { outgoingEdges: (graph: WorkflowGraph, nodeId: NodeId) => readonly WorkflowEdge[] };
  readonly runCapability: (request: ExecutionRequest, cancellation: WorkflowContext['cancellation']) => Promise<ExecutionResult>;
  readonly runNestedGraph: (graph: WorkflowGraph, context: WorkflowContext, outputs: Readonly<Record<string, unknown>>) => Promise<Result<{ outputs: Readonly<Record<string, unknown>>; nodeReceipts: readonly WorkflowNodeReceipt[]; resourceUsage: NodeHandlerResult['resourceUsage'] }, RuntimeError>>;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function builtinNodeHandlers(deps: BuiltinHandlerDeps): ReadonlyMap<string, NodeHandler> {
  return new Map<string, NodeHandler>([
    ['start', structuralHandler],
    ['end', structuralHandler],
    ['sequence', structuralHandler],
    ['parallel', structuralHandler],
    ['merge', structuralHandler],
    ['capability', makeCapabilityNodeHandler(deps.runCapability)],
    ['decision', decisionHandler(deps.scheduler)],
    ['loop', makeLoopHandler(deps.runNestedGraph)],
    ['delay', makeDelayHandler(deps.sleep)],
    ['subworkflow', makeSubworkflowHandler(deps.runNestedGraph)],
  ]);
}

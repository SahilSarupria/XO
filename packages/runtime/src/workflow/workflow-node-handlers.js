import { err, ok } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { RequestId } from '../ids.js';
import { evaluateCondition } from './workflow-condition.js';
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
export function makeCapabilityNodeHandler(runCapability) {
    return async (node, context) => {
        const config = node.config ?? {};
        const capabilityId = typeof config.capabilityId === 'string' ? config.capabilityId : undefined;
        if (!capabilityId) {
            return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Workflow node "${node.id}" (type "capability") is missing a string "capabilityId" in its config`));
        }
        const input = typeof config.input === 'string' ? config.input : '';
        const auxiliaryCapabilityIds = Array.isArray(config.auxiliaryCapabilityIds) ? config.auxiliaryCapabilityIds : undefined;
        const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : undefined;
        const nodeRequest = {
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
async function structuralHandler() {
    return ok({});
}
function decisionHandler(scheduler) {
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
function makeLoopHandler(runNestedGraph) {
    return async (node, context) => {
        const config = node.config ?? {};
        const bodyGraph = config.bodyGraph;
        if (!bodyGraph) {
            return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Loop node "${node.id}" is missing a "bodyGraph" in its config`));
        }
        const maxIterations = typeof config.maxIterations === 'number' ? config.maxIterations : DEFAULT_MAX_LOOP_ITERATIONS;
        const exitCondition = config.exitCondition;
        let outputs = context.state.outputs;
        const nodeReceipts = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let estimatedCost = 0;
        let iterations = 0;
        while (iterations < maxIterations) {
            if (exitCondition && evaluateCondition(exitCondition, outputs))
                break;
            if (context.cancellation.isCancelled)
                break;
            const iterationResult = await runNestedGraph(bodyGraph, context, outputs);
            if (!iterationResult.ok)
                return iterationResult;
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
function makeDelayHandler(sleep) {
    return async (node, context) => {
        const config = node.config ?? {};
        const durationMs = typeof config.durationMs === 'number' ? config.durationMs : 0;
        await sleep(durationMs, context.cancellation.signal);
        return ok({ output: { delayedMs: durationMs } });
    };
}
function makeSubworkflowHandler(runNestedGraph) {
    return async (node, context) => {
        const config = node.config ?? {};
        const graph = config.graph;
        if (!graph) {
            return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Subworkflow node "${node.id}" is missing a "graph" in its config`));
        }
        const result = await runNestedGraph(graph, context, context.state.outputs);
        if (!result.ok)
            return result;
        return ok({ output: result.value.outputs, nodeReceipts: result.value.nodeReceipts, ...(result.value.resourceUsage ? { resourceUsage: result.value.resourceUsage } : {}) });
    };
}
export function builtinNodeHandlers(deps) {
    return new Map([
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
//# sourceMappingURL=workflow-node-handlers.js.map
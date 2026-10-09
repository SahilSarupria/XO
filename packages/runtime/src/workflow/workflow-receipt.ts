import type { RuntimeError } from '@xo/errors';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
import type { NodeId } from './workflow-graph.js';
import { WorkflowReceiptId, type WorkflowInstanceId } from '../ids.js';
import type { WorkflowInstance, WorkflowInstanceStatus } from './workflow-instance.js';
import type { WorkflowResourceUsage } from './workflow-state.js';

/** One `capability` (or `subworkflow`, recursively) node's own Stage 2 `ExecutionReceipt`, attributed back to the workflow node that produced it. Every other node type contributes no entry here — there's nothing for a `decision`/`delay`/`start`/`end` node to receipt in Stage 2's sense. */
export interface WorkflowNodeReceipt {
  readonly nodeId: NodeId;
  readonly receipt: ExecutionReceipt;
}

/**
 * The immutable record one workflow run produces — the workflow-level
 * analogue of Stage 1/2's `ExecutionReceipt`, aggregating every
 * `capability`/`subworkflow` node's own receipt plus workflow-wide
 * resource usage and timing.
 */
export interface WorkflowReceipt {
  readonly receiptId: WorkflowReceiptId;
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly graphId: string;
  readonly status: WorkflowInstanceStatus;
  readonly nodeReceipts: readonly WorkflowNodeReceipt[];
  readonly completedNodeCount: number;
  readonly failedNodeCount: number;
  readonly skippedNodeCount: number;
  readonly resourceUsage: WorkflowResourceUsage;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface BuildWorkflowReceiptParams {
  readonly instance: WorkflowInstance;
  readonly nodeReceipts: readonly WorkflowNodeReceipt[];
  readonly durationMs: number;
  readonly now?: () => Date;
}

export function buildWorkflowReceipt(params: BuildWorkflowReceiptParams): WorkflowReceipt {
  const { instance, nodeReceipts, durationMs, now = () => new Date() } = params;
  return Object.freeze({
    receiptId: WorkflowReceiptId(`wfreceipt_${instance.workflowInstanceId}_${now().getTime()}`),
    workflowInstanceId: instance.workflowInstanceId,
    graphId: instance.graph.graphId,
    status: instance.status,
    nodeReceipts,
    completedNodeCount: instance.state.completedNodes.length,
    failedNodeCount: instance.state.failedNodes.length,
    skippedNodeCount: instance.state.skippedNodes.length,
    resourceUsage: instance.state.resourceUsage,
    durationMs,
    createdAt: now().toISOString(),
  });
}

/**
 * `WorkflowExecutor.run`/`resume`'s return value — exactly one of
 * `receipt`/`error` is set, mirroring Stage 2's `ExecutionResult`:
 * `instance.status === 'completed'` implies `receipt` is present;
 * `'failed'`/`'cancelled'`/`'timed_out'` implies `error` instead.
 * `'suspended'` (mid-checkpoint-and-stop) sets neither — a suspended
 * workflow hasn't failed, it just isn't finished, and resuming it later
 * is the normal continuation, not error recovery.
 */
export interface WorkflowResult {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly instance: WorkflowInstance;
  readonly receipt?: WorkflowReceipt;
  readonly error?: RuntimeError;
}

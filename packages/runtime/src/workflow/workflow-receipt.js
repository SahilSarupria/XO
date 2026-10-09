import { WorkflowReceiptId } from '../ids.js';
export function buildWorkflowReceipt(params) {
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
//# sourceMappingURL=workflow-receipt.js.map
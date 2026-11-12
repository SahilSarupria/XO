import type { PermissionManager } from '@xo/permissions';
import { NotFoundError, type XoError } from '@xo/errors';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import type { RecordedAuthentication } from '../auth/recorded-authentication.js';
import { deriveCapabilityApprovalState } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import {
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceExecutionsStore,
  workspaceWorkflowExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { FsWorkflowExecutionStore } from './fs-workflow-execution-store.js';
import { buildWorkflowView, composeCompilationWorkflows, resolveWorkflow, type WorkflowView } from './workflow-catalog.js';
import type { WorkflowRunnerContext } from './workflow-runner.js';

/** The one place a runner context is assembled from a workspace's server-controlled stores. */
export function makeRunnerContext(
  workspace: WorkspaceRecord,
  principal: AuthenticatedPrincipal,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
  authentication?: RecordedAuthentication,
): WorkflowRunnerContext {
  return {
    workspace,
    principal,
    permissionManager,
    ...(authentication !== undefined ? { authentication } : {}),
    compilationStore: new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)),
    approvalStore: new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig)),
    executionStore: new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig)),
    workflowStore: new FsWorkflowExecutionStore(workspaceWorkflowExecutionsStore(workspace, dataConfig)),
  };
}

export interface UnavailableCompilation {
  readonly compilationId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** Every workflow the workspace's succeeded compilations compose, with this workspace's approvals applied. */
export async function loadWorkflowViews(
  ctx: WorkflowRunnerContext,
  onlyCompilationId?: string,
): Promise<{ workflows: WorkflowView[]; unavailable: UnavailableCompilation[] }> {
  const listed = await ctx.compilationStore.list();
  if (!listed.ok) throw listed.error;
  const compilations = listed.value.filter(
    (c) => c.status === 'succeeded' && (onlyCompilationId === undefined || c.compilationId === onlyCompilationId),
  );
  if (onlyCompilationId !== undefined && compilations.length === 0) throw new NotFoundError(`compilation "${onlyCompilationId}"`);

  const workflows: WorkflowView[] = [];
  const unavailable: UnavailableCompilation[] = [];
  for (const compilation of compilations) {
    const graphJson = await ctx.compilationStore.getCompiledGraph(compilation.compilationId);
    const composed = graphJson.ok
      ? composeCompilationWorkflows(graphJson.value, compilation.completedAt ?? compilation.createdAt)
      : undefined;
    if (!graphJson.ok || composed === undefined || !composed.ok) {
      const error = !graphJson.ok ? graphJson.error : (composed as { error: XoError }).error;
      unavailable.push({ compilationId: compilation.compilationId, errorCode: error.code, errorMessage: error.message });
      continue;
    }
    for (const workflow of composed.value.workflows) {
      const resolved = resolveWorkflow(composed.value.graph, workflow);
      const approved = new Set<string>();
      for (const step of workflow.steps) {
        // Approved means approved for the capability's CURRENT material state (P1.0 M3).
        const verdict = await verifyApproval(
          ctx.approvalStore,
          { workspaceId: ctx.workspace.workspaceId, compilationId: compilation.compilationId, capabilityId: step.capabilityId },
          deriveCapabilityApprovalState(composed.value.graph, step.capabilityId, compilation.sourceDigestSha256),
        );
        if (verdict.ok && verdict.value.approved) approved.add(step.capabilityId);
      }
      workflows.push(buildWorkflowView(compilation.compilationId, compilation.sourceId, resolved, approved));
    }
  }
  return { workflows, unavailable };
}

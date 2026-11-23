import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import type { ApprovalStore } from '../approvals/approval.js';
import type { RecordedAuthentication } from '../auth/recorded-authentication.js';
import type { CompilationStore } from '../compilations/compilation.js';
import type { ExecutionStore } from '../executions/execution.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkflowExecutionRecord, WorkflowExecutionStore } from './workflow-execution.js';

/**
 * UW-12b (ADR 0052): what remains of the composed-workflow runner is the READ side. The runner itself (start, resume, recovery and the
 * draft launcher) was removed; its historic executions stay readable here exactly as stored. Nothing in this file starts, resumes or
 * changes a run.
 */
export interface WorkflowRunnerContext {
  readonly workspace: WorkspaceRecord;
  readonly principal: AuthenticatedPrincipal;
  readonly permissionManager: PermissionManager;
  readonly authentication?: RecordedAuthentication;
  readonly compilationStore: CompilationStore;
  readonly approvalStore: ApprovalStore;
  readonly executionStore: ExecutionStore;
  readonly workflowStore: WorkflowExecutionStore;
}

export interface WorkflowExecutionView extends Omit<WorkflowExecutionRecord, 'pendingHumanTask'> {
  readonly pendingHumanTask?: {
    readonly stepIndex: number;
    readonly executionId: string;
    readonly humanTaskStatus: 'pending' | 'resolved';
  };
}

export async function toWorkflowExecutionView(ctx: WorkflowRunnerContext, record: WorkflowExecutionRecord): Promise<WorkflowExecutionView> {
  const { pendingHumanTask, ...base } = record;
  if (pendingHumanTask === undefined) return base;
  const exec = await ctx.executionStore.get(pendingHumanTask.executionId);
  const humanTaskStatus = exec.ok && exec.value.humanTask?.status === 'resolved' ? 'resolved' : 'pending';
  return { ...base, pendingHumanTask: { ...pendingHumanTask, humanTaskStatus } };
}

export async function getWorkflowExecution(ctx: WorkflowRunnerContext, workflowExecutionId: string): Promise<WorkflowExecutionRecord> {
  const found = await ctx.workflowStore.get(workflowExecutionId);
  if (!found.ok) throw found.error;
  return found.value;
}

export async function listWorkflowExecutions(ctx: WorkflowRunnerContext): Promise<readonly WorkflowExecutionRecord[]> {
  const listed = await ctx.workflowStore.list();
  if (!listed.ok) throw listed.error;
  return listed.value;
}

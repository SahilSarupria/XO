import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import { BatchStore, batchDir } from '../approvals/batch-approval.js';
import { auditRunRef, readMeta, runnerFor, runsDir, type RunnerDeps } from '../routes/generated-run-routes.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import { safeId } from '../audit/audit-service.js';
import { roleAllows } from '../workspace/permissions.js';
import { roleOf, type WorkspaceRecord } from '../workspace/workspace.js';
import { RunStore } from '@xo/workflow-runtime';
import { readDelegation, writeDelegation } from './delegation.js';

/** UW-12b (ADR 0052 decision 3): delegating a waiting step, and asking for changes to a batch preview. */

export interface DelegateStep {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly approvalId: string;
  readonly to: unknown;
  readonly reason: unknown;
  readonly revision?: unknown;
  readonly correlationId: string;
  readonly workflowId?: string;
}

export async function delegateStep(deps: RunnerDeps, d: DelegateStep): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId, approvalId } = d;
  if (typeof d.to !== 'string' || d.to.length === 0 || d.to.length > 128)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'to must be an identity id');
  if (typeof d.reason !== 'string' || d.reason.trim() === '' || d.reason.length > 1000)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason is required, at most 1000 characters');
  if (d.revision !== undefined && (typeof d.revision !== 'number' || !Number.isInteger(d.revision) || d.revision < 0))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'revision must be a whole number');
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const meta = await readMeta(dir, runId);
  if (d.workflowId !== undefined && meta?.workflow?.workflowId !== d.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${d.workflowId}"`);
  const runner = await runnerFor(deps, workspace, definition, { reviewer: { id: actor.id } });
  const request = (await runner.listApprovals()).find((a) => a.runId === runId && a.approvalId === approvalId);
  if (request === undefined) throw new NotFoundError(`pending approval "${approvalId}" on run "${runId}"`);
  const role = roleOf(workspace, d.to);
  if (role === undefined || !roleAllows(role, 'review'))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the person it is delegated to must be able to review in this workspace', {
      context: { reason: 'delegate_cannot_review' },
    });
  // Someone other than the delegate may take it over only by being able to review; an earlier delegate cannot re-delegate it away.
  const current = await readDelegation(dir, approvalId);
  if (current !== undefined && current.to !== actor.id && roleOf(workspace, actor.id) !== 'admin')
    throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, 'this step is delegated to someone else; only an admin may take it back', {
      context: { reason: 'delegated' },
    });
  const written = await writeDelegation(
    dir,
    { approvalId, runId, to: d.to, by: actor.id, at: new Date().toISOString(), reason: d.reason.trim() },
    typeof d.revision === 'number' ? d.revision : undefined,
  );
  await deps.audit?.tryRecord({
    action: 'generated-workflow.delegate',
    actor: actorFromPrincipal(actor),
    correlationId: d.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.approval.delegated',
    outcome: 'completed',
    // Identity ids and counts only: never the reason, never an email.
    metadata: {
      ...(await auditRunRef(new RunStore(dir), runId)),
      step: safeId(request.step) ?? 'step',
      revision: written.revision,
    },
  });
  return { runId, approvalId, assignedTo: written.to, revision: written.revision };
}

export interface RequestBatchChanges {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly previewId: string;
  readonly comment: unknown;
  readonly correlationId: string;
}

export async function requestBatchChanges(deps: RunnerDeps, r: RequestBatchChanges): Promise<Record<string, unknown>> {
  const { workspace, actor, definition } = r;
  if (typeof r.comment !== 'string' || r.comment.trim() === '' || r.comment.length > 2000)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'comment (what should change) is required, at most 2000 characters');
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const bs = new BatchStore(batchDir(dir));
  const preview = await bs.getPreview(r.previewId);
  if (preview.definitionId !== definition.definitionId || preview.standingSample === true)
    throw new NotFoundError(`batch preview "${r.previewId}"`);
  const refuse = (code: string, message: string): never => {
    throw new XoError(ErrorCode.BATCH_APPROVAL_REFUSED, message, { context: { reason: code } });
  };
  if ((await bs.getApprovalOfPreview(preview.previewId)) !== undefined)
    refuse('already_approved', 'this preview is already approved; revoke the approval instead');
  if (Date.parse(preview.expiresAt) <= Date.now()) refuse('preview_expired', 'this preview expired; prepare a new one');
  const record = await bs.requestChanges({
    previewId: preview.previewId,
    by: actor.id,
    at: new Date().toISOString(),
    comment: r.comment.trim(),
  });
  await deps.audit?.tryRecord({
    action: 'generated-workflow.batch',
    actor: actorFromPrincipal(actor),
    correlationId: r.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.batch.changes-requested',
    outcome: 'completed',
    metadata: { previewId: preview.previewId },
  });
  return { previewId: preview.previewId, changesRequested: { by: record.by, at: record.at, comment: record.comment } };
}

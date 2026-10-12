import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { PermissionManager } from '@xo/permissions';
import {
  requirePrincipal,
  workspaceCompilationsStore,
  workspaceApprovalsStore,
  workspaceExecutionsStore,
  workspaceWorkflowExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { isApproved } from '../approvals/approval.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import { FsWorkflowExecutionStore } from '../workflows/fs-workflow-execution-store.js';
import { composeCompilationWorkflows, resolveWorkflow, buildWorkflowView, type WorkflowView } from '../workflows/workflow-catalog.js';
import {
  getWorkflowExecution,
  listWorkflowExecutions,
  resumeWorkflowExecution,
  startWorkflowExecution,
  toWorkflowExecutionView,
  type ResumeWorkflowRequest,
  type WorkflowRunnerContext,
} from '../workflows/workflow-runner.js';
import type { HumanTaskDecision } from '../executions/execution.js';
import { actorFromPrincipal, type AuditEventDraft, type AuditEventType } from '@xo/audit';
import type { WorkflowExecutionRecord } from '../workflows/workflow-execution.js';
import {
  auditedOwnedWorkspace,
  auditedRead,
  finalizationNotice,
  newCorrelationId,
  safeId,
  type AuditFinalization,
  type AuditService,
} from '../audit/audit-service.js';

/**
 * P0.8 workflow routes. Same conventions as every other workspace-bound
 * route family: `requireOwnedWorkspace` first (cross-workspace => 404),
 * storage resolved only through server-controlled `workspace-context.ts`
 * helpers, identity only ever from the authenticated request.
 *
 * Request bodies are validated STRICTLY: any field not on the endpoint's
 * short allow-list is a 400 (P0.8 decision — stricter than P0.5/P0.7,
 * which ignore unknown fields). There is deliberately no field through
 * which a client could supply steps, capability ids, execution classes,
 * bindings, runtime declarations, filesystem paths or storage keys; a
 * client attempting to is told so, rather than silently ignored.
 */

const MAX_WORKFLOW_INPUT_BYTES = 64 * 1024;
const MAX_DECISION_DATA_BYTES = 8 * 1024; // same bound as P0.7's human-task route

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[], endpoint: string): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      `unknown request field(s) for ${endpoint}: ${unknown.map((k) => `"${k}"`).join(', ')}. Allowed fields: ${allowed.join(', ')}. Workflow steps, capability ids, execution classes, bindings and runtime declarations are always derived from the stored compilation and can never be supplied by a client.`,
      { context: { unknownFields: unknown, allowedFields: allowed } },
    );
  }
}

async function readJsonObject(req: ApiRequest, { allowEmpty }: { readonly allowEmpty: boolean }): Promise<Record<string, unknown>> {
  if (allowEmpty && (await req.rawBody()).length === 0) return {};
  const parsed = await req.json<unknown>();
  if (!parsed.ok) throw parsed.error;
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
  return parsed.value as Record<string, unknown>;
}

function boundedPlainObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${field}", if present, must be a plain JSON object`);
  if (JSON.stringify(value).length > maxBytes)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${field}" must be at most ${maxBytes} bytes serialized`);
  return value as Record<string, unknown>;
}

/**
 * Records what a start/resume segment ACTUALLY produced, from the persisted record: per-step terminal outcomes
 * (best effort, one event each) and then the workflow-level outcome (the finalization reported to the caller).
 * Step events are written when the segment returns, so they describe real persisted step states but are not a live
 * stream; a crash before this point leaves the attempt event with no outcome (see docs/audit-operations.md).
 */
async function recordWorkflowOutcome(
  audit: AuditService,
  base: Omit<AuditEventDraft, 'type' | 'outcome'>,
  record: WorkflowExecutionRecord,
  correlationId: string,
): Promise<AuditFinalization> {
  const workflowExecutionId = safeId(record.workflowExecutionId);
  for (const step of record.steps) {
    const stepId = safeId(step.stepId);
    const done = step.status === 'succeeded';
    const failed = step.status === 'failed' || step.status === 'rejected';
    if (!done && !failed) continue;
    await audit.tryRecord({
      ...base,
      type: done ? 'workflow.step.completed' : 'workflow.step.failed',
      outcome: done ? 'completed' : 'failed',
      ...(workflowExecutionId !== undefined ? { executionId: workflowExecutionId } : {}),
      ...(stepId !== undefined
        ? {
            target: {
              kind: 'workflow-step' as const,
              id: stepId,
              ...(base.target?.workspaceId !== undefined ? { workspaceId: base.target.workspaceId } : {}),
            },
          }
        : {}),
      metadata: { stepStatus: String(step.status) },
    });
  }
  const type: AuditEventType =
    record.status === 'succeeded'
      ? 'workflow.completed'
      : record.status === 'failed' || record.status === 'rejected' || record.status === 'interrupted'
        ? 'workflow.failed'
        : record.status === 'waiting_for_human'
          ? 'workflow.waiting_for_human'
          : 'workflow.resumed';
  const bad = record.status === 'failed' || record.status === 'rejected' || record.status === 'interrupted';
  return audit.finalize(
    {
      ...base,
      type,
      outcome: bad ? 'failed' : 'completed',
      ...(workflowExecutionId !== undefined ? { executionId: workflowExecutionId } : {}),
      metadata: { ...(base.metadata ?? {}), workflowStatus: String(record.status), revision: record.revision },
    },
    { correlationId, ...(workflowExecutionId !== undefined ? { executionId: workflowExecutionId } : {}) },
  );
}

export function registerWorkflowRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  function runnerContext(workspace: WorkspaceRecord, principal: AuthenticatedPrincipal): WorkflowRunnerContext {
    return {
      workspace,
      principal,
      permissionManager,
      compilationStore: new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)),
      approvalStore: new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig)),
      executionStore: new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig)),
      workflowStore: new FsWorkflowExecutionStore(workspaceWorkflowExecutionsStore(workspace, dataConfig)),
    };
  }

  // GET /workspaces/:workspaceId/workflows[?compilationId=]
  async function listWorkflows(req: ApiRequest): Promise<ApiResponse> {
    return auditedRead(req, auditCtx, { action: 'list.workflows', kind: 'workflow' }, (workspace) => listWorkflowsFor(req, workspace));
  }

  async function listWorkflowsFor(req: ApiRequest, workspace: WorkspaceRecord): Promise<ApiResponse> {
    const ctx = runnerContext(workspace, requirePrincipal(req));
    const only = req.query.get('compilationId');

    const listed = await ctx.compilationStore.list();
    if (!listed.ok) throw listed.error;
    const compilations = listed.value.filter((c) => c.status === 'succeeded' && (only === null || c.compilationId === only));
    if (only !== null && compilations.length === 0) throw new NotFoundError(`compilation "${only}"`);

    const workflows: WorkflowView[] = [];
    const unavailable: { compilationId: string; errorCode: string; errorMessage: string }[] = [];
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
          const approval = await ctx.approvalStore.get(compilation.compilationId, step.capabilityId);
          if (approval.ok && isApproved(approval.value)) approved.add(step.capabilityId);
        }
        workflows.push(buildWorkflowView(compilation.compilationId, compilation.sourceId, resolved, approved));
      }
    }
    return json(200, { workflows, ...(unavailable.length > 0 ? { unavailableCompilations: unavailable } : {}) });
  }

  // POST /workspaces/:workspaceId/workflows/:workflowId/executions
  async function startExecution(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'start.workflow', correlationId });
    const workflowId = req.params['workflowId'];
    if (workflowId === undefined || workflowId.length === 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workflow id');

    const body = await readJsonObject(req, { allowEmpty: false });
    rejectUnknownFields(body, ['compilationId', 'workflowId', 'input'], 'POST .../workflows/:workflowId/executions');
    if (typeof body['compilationId'] !== 'string' || body['compilationId'].length === 0)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"compilationId" (string) is required');
    if (body['workflowId'] !== undefined && body['workflowId'] !== workflowId)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"workflowId" in the body, if present, must equal the workflowId in the path');
    const input = body['input'] === undefined ? {} : boundedPlainObject(body['input'], 'input', MAX_WORKFLOW_INPUT_BYTES);

    const principal = requirePrincipal(req);
    const ctx = runnerContext(workspace, principal);
    const wfTarget = safeId(workflowId);
    const base = {
      action: 'start.workflow',
      actor: actorFromPrincipal(principal),
      correlationId,
      target:
        wfTarget !== undefined
          ? { kind: 'workflow' as const, id: wfTarget, workspaceId: workspace.workspaceId }
          : { kind: 'workspace' as const, id: workspace.workspaceId },
      ...(safeId(body['compilationId']) !== undefined ? { metadata: { compilationId: body['compilationId'] } } : {}),
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    // PRECONDITION: durable evidence of the attempt BEFORE the runner authorizes, persists or executes anything.
    await audit.requireDurable({ ...base, type: 'workflow.attempted', outcome: 'attempted' });
    let record;
    try {
      record = await startWorkflowExecution(ctx, { compilationId: body['compilationId'], workflowId, input });
    } catch (cause) {
      const denied = cause instanceof XoError && cause.code === ErrorCode.RUNTIME_PERMISSION_DENIED;
      await audit.tryRecord({
        ...base,
        type: denied ? 'workflow.denied' : 'workflow.failed',
        outcome: denied ? 'denied' : 'failed',
        reasonCode: cause instanceof XoError ? cause.code : ErrorCode.UNKNOWN,
      });
      throw cause;
    }
    const finalization = await recordWorkflowOutcome(audit, base, record, correlationId);
    // Same convention as P0.5: a run that FAILED is still a real, persisted, structured response (200), never a bare 4xx/5xx that discards the record.
    return json(record.status === 'failed' ? 200 : 201, {
      ...(await toWorkflowExecutionView(ctx, record)),
      ...finalizationNotice(finalization),
    });
  }

  async function listExecutions(req: ApiRequest): Promise<ApiResponse> {
    return auditedRead(req, auditCtx, { action: 'list.workflow-executions', kind: 'workflow-execution' }, async (workspace) => {
      const ctx = runnerContext(workspace, requirePrincipal(req));
      const records = await listWorkflowExecutions(ctx);
      return json(200, { workflowExecutions: await Promise.all(records.map((r) => toWorkflowExecutionView(ctx, r))) });
    });
  }

  async function getExecution(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['workflowExecutionId'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workflow execution id');
    return auditedRead(
      req,
      auditCtx,
      { action: 'get.workflow-execution', kind: 'workflow-execution', idParam: 'workflowExecutionId' },
      async (workspace) => {
        const ctx = runnerContext(workspace, requirePrincipal(req));
        const record = await getWorkflowExecution(ctx, id);
        return json(200, await toWorkflowExecutionView(ctx, record));
      },
    );
  }

  // POST /workspaces/:workspaceId/workflow-executions/:workflowExecutionId/resume
  async function resumeExecution(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'resume.workflow', correlationId });
    const id = req.params['workflowExecutionId'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workflow execution id');

    const body = await readJsonObject(req, { allowEmpty: true });
    rejectUnknownFields(
      body,
      ['decision', 'data', 'expectedStepExecutionId', 'expectedRevision'],
      'POST .../workflow-executions/:workflowExecutionId/resume',
    );

    let decision: HumanTaskDecision | undefined;
    if (body['decision'] !== undefined) {
      if (body['decision'] !== 'approve' && body['decision'] !== 'reject')
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"decision" must be one of: approve, reject');
      decision = body['decision'];
    }
    let data: Record<string, unknown> | undefined;
    if (body['data'] !== undefined) {
      if (decision === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"data" may only be supplied together with "decision"');
      data = boundedPlainObject(body['data'], 'data', MAX_DECISION_DATA_BYTES);
    }
    if (
      body['expectedStepExecutionId'] !== undefined &&
      (typeof body['expectedStepExecutionId'] !== 'string' || body['expectedStepExecutionId'].length === 0)
    )
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedStepExecutionId" must be a non-empty string');
    if (
      body['expectedRevision'] !== undefined &&
      (typeof body['expectedRevision'] !== 'number' || !Number.isInteger(body['expectedRevision']) || body['expectedRevision'] < 0)
    )
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedRevision" must be a non-negative integer');

    const request: ResumeWorkflowRequest = {
      ...(decision !== undefined ? { decision } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(typeof body['expectedStepExecutionId'] === 'string' ? { expectedStepExecutionId: body['expectedStepExecutionId'] } : {}),
      ...(typeof body['expectedRevision'] === 'number' ? { expectedRevision: body['expectedRevision'] } : {}),
    };

    const principal = requirePrincipal(req);
    const ctx = runnerContext(workspace, principal);
    const resumeTarget = safeId(id);
    const base = {
      action: 'resume.workflow',
      actor: actorFromPrincipal(principal),
      correlationId,
      target:
        resumeTarget !== undefined
          ? { kind: 'workflow-execution' as const, id: resumeTarget, workspaceId: workspace.workspaceId }
          : { kind: 'workspace' as const, id: workspace.workspaceId },
      ...(resumeTarget !== undefined ? { executionId: resumeTarget } : {}),
      ...(decision !== undefined ? { metadata: { decision } } : {}),
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    // PRECONDITION: durable evidence of the resume / HITL-decision attempt BEFORE any state transition.
    await audit.requireDurable({ ...base, type: 'workflow.attempted', outcome: 'attempted' });
    // Ownership of the workflow execution is implicit in the workspace-scoped store: an id from another workspace simply does not exist here (404).
    let record;
    try {
      record = await resumeWorkflowExecution(ctx, id, request);
    } catch (cause) {
      const denied = cause instanceof XoError && cause.code === ErrorCode.RUNTIME_PERMISSION_DENIED;
      await audit.tryRecord({
        ...base,
        type: denied ? 'workflow.denied' : 'workflow.failed',
        outcome: denied ? 'denied' : 'failed',
        reasonCode: cause instanceof XoError ? cause.code : ErrorCode.UNKNOWN,
      });
      throw cause;
    }
    const finalization = await recordWorkflowOutcome(audit, base, record, correlationId);
    return json(200, { ...(await toWorkflowExecutionView(ctx, record)), ...finalizationNotice(finalization) });
  }

  router.get('/workspaces/:workspaceId/workflows', guarded(listWorkflows));
  router.post('/workspaces/:workspaceId/workflows/:workflowId/executions', guarded(startExecution));
  router.get('/workspaces/:workspaceId/workflow-executions', guarded(listExecutions));
  router.get('/workspaces/:workspaceId/workflow-executions/:workflowExecutionId', guarded(getExecution));
  router.post('/workspaces/:workspaceId/workflow-executions/:workflowExecutionId/resume', guarded(resumeExecution));
}

import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { toRecordedAuthentication } from '../auth/recorded-authentication.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  requirePrincipal,
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceExecutionsStore,
  workspaceStateStore,
  workspaceWorkflowExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import { FsWorkflowExecutionStore } from '../workflows/fs-workflow-execution-store.js';
import { loadDraftFacts, DRAFT_WORKFLOW_PREFIX } from '../workflows/draft-workflow.js';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKey } from '../workflows/workflow-idempotency.js';
import { startWorkflowExecutionDetailed, toWorkflowExecutionView, type WorkflowRunnerContext } from '../workflows/workflow-runner.js';
import { WorkflowConflictError } from '../workflows/workflow-execution.js';
import type { DefinitionInput } from '../workflow-definitions/definition.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { recordAudit } from '../audit/record.js';
import { analyzeDefinition, parseDefinitionInput, type WorkflowDefinition } from '../workflow-definitions/definition.js';
import { FsDefinitionStore, MAX_DEFINITIONS } from '../workflow-definitions/fs-definition-store.js';

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

const MAX_RUN_INPUT_BYTES = 64 * 1024;

function compilationIdsOf(input: DefinitionInput): string[] {
  return input.nodes.flatMap((n) =>
    n.kind === 'capability' && typeof n.config['compilationId'] === 'string' ? [n.config['compilationId']] : [],
  );
}

export function registerWorkflowDefinitionRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const store = (w: WorkspaceRecord) => new FsDefinitionStore(workspaceStateStore(w, dataConfig), w.workspaceId);
  const compilationStore = (w: WorkspaceRecord) => new FsCompilationStore(workspaceCompilationsStore(w, dataConfig));
  const approvalStore = (w: WorkspaceRecord) => new FsApprovalStore(workspaceApprovalsStore(w, dataConfig));

  /** Analysis against what the platform knows right now about the compilations the draft names. */
  async function analyze(w: WorkspaceRecord, input: DefinitionInput) {
    const facts = await loadDraftFacts({ compilationStore: compilationStore(w), approvalStore: approvalStore(w) }, compilationIdsOf(input));
    return analyzeDefinition(input, facts);
  }
  const view = async (w: WorkspaceRecord, d: WorkflowDefinition) => ({ ...d, analysis: await analyze(w, d) });

  async function expectedRevision(body: unknown): Promise<number | undefined> {
    const v = (body as { expectedRevision?: unknown } | null)?.expectedRevision;
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedRevision" must be a positive integer');
    return v;
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const defs = await store(w).list();
    return json(200, {
      definitions: defs.map((d) => ({
        definitionId: d.definitionId,
        name: d.name,
        status: d.status,
        revision: d.revision,
        nodeCount: d.nodes.length,
        updatedAt: d.updatedAt,
        updatedBy: d.updatedBy,
      })),
    });
  }

  async function get(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const id = req.params['definitionId'] ?? '';
    const d = await store(w).get(id);
    if (d === undefined) throw new NotFoundError(`workflow definition "${id}"`);
    return json(200, await view(w, d));
  }

  async function create(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'save workflow definition' });
    const body = await req.json();
    if (!body.ok) throw body.error;
    const input = parseDefinitionInput(body.value);
    const s = store(w);
    if ((await s.list()).length >= MAX_DEFINITIONS)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `this workspace has reached ${MAX_DEFINITIONS} workflow definitions`);
    const d = await s.create(input, callerIdentityId(req), new Date());
    await recordAudit(req, w, dataConfig, {
      event: 'workflow.definition_saved',
      result: 'succeeded',
      target: { kind: 'workflow_definition', id: d.definitionId, label: d.name },
      detail: { revision: d.revision, nodes: d.nodes.length },
    });
    return json(201, await view(w, d));
  }

  async function replace(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'save workflow definition' });
    const id = req.params['definitionId'] ?? '';
    const body = await req.json();
    if (!body.ok) throw body.error;
    const rev = await expectedRevision(body.value);
    const input = parseDefinitionInput(body.value);
    const d = await store(w).replace(id, input, rev, callerIdentityId(req), new Date());
    if (d === undefined) throw new NotFoundError(`workflow definition "${id}"`);
    await recordAudit(req, w, dataConfig, {
      event: 'workflow.definition_saved',
      result: 'succeeded',
      target: { kind: 'workflow_definition', id, label: d.name },
      detail: { revision: d.revision, nodes: d.nodes.length },
    });
    return json(200, await view(w, d));
  }

  async function remove(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'delete workflow definition' });
    const id = req.params['definitionId'] ?? '';
    if (!(await store(w).delete(id))) throw new NotFoundError(`workflow definition "${id}"`);
    await recordAudit(req, w, dataConfig, {
      event: 'workflow.definition_deleted',
      result: 'succeeded',
      target: { kind: 'workflow_definition', id },
    });
    return json(200, { deleted: id });
  }

  /** Validate without saving: what the editor shows as live errors. */
  async function validate(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const body = await req.json();
    if (!body.ok) throw body.error;
    return json(200, await analyze(w, parseDefinitionInput(body.value)));
  }

  /**
   * Runs a saved draft through the same engine, approval gate and human-task path as a derived workflow.
   * Refuses with 501 and the analysis (blockers) when the draft is not runnable; nothing is persisted then.
   */
  async function run(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'run workflow definition' });
    const id = req.params['definitionId'] ?? '';
    const d = await store(w).get(id);
    if (d === undefined) throw new NotFoundError(`workflow definition "${id}"`);

    let body: Record<string, unknown> = {};
    if ((await req.rawBody()).length > 0) {
      const parsed = await req.json<unknown>();
      if (!parsed.ok) throw parsed.error;
      if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
      body = parsed.value as Record<string, unknown>;
    }
    for (const k of Object.keys(body))
      if (!['input', 'expectedRevision'].includes(k))
        throw new XoError(
          ErrorCode.INVALID_ARGUMENT,
          `unknown request field "${k}". Allowed fields: input, expectedRevision. Steps, capability ids and bindings come from the saved draft and the stored compilation, never from the request.`,
        );
    let input: Record<string, unknown> = {};
    if (body['input'] !== undefined) {
      const v = body['input'];
      if (typeof v !== 'object' || v === null || Array.isArray(v) || JSON.stringify(v).length > MAX_RUN_INPUT_BYTES)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `"input" must be a plain JSON object of at most ${MAX_RUN_INPUT_BYTES} bytes`);
      input = v as Record<string, unknown>;
    }
    if (body['expectedRevision'] !== undefined) {
      const rev = body['expectedRevision'];
      if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedRevision" must be a positive integer');
      if (rev !== d.revision)
        throw new WorkflowConflictError(
          `workflow definition "${id}" is at revision ${d.revision}, not the expected ${rev}; nothing was run`,
          'stale_revision',
          { definitionId: id, revision: d.revision, expectedRevision: rev },
        );
    }

    const analysis = await analyze(w, d);
    if (!analysis.runnable || analysis.plan === undefined) {
      return json(501, {
        error: {
          code: ErrorCode.UNIMPLEMENTED,
          message: 'This draft cannot run on this server. analysis.blockers and analysis.errors say exactly why; nothing was started.',
        },
        analysis,
      });
    }

    const principal = requirePrincipal(req);
    const authentication = toRecordedAuthentication(req.authentication);
    const ctx: WorkflowRunnerContext = {
      workspace: w,
      principal,
      ...(authentication !== undefined ? { authentication } : {}),
      compilationStore: compilationStore(w),
      approvalStore: approvalStore(w),
      executionStore: new FsExecutionStore(workspaceExecutionsStore(w, dataConfig)),
      workflowStore: new FsWorkflowExecutionStore(workspaceWorkflowExecutionsStore(w, dataConfig)),
    };
    const plan = analysis.plan;
    const idempotencyKey = parseIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
    const { record, replayed } = await startWorkflowExecutionDetailed(ctx, {
      compilationId: plan.compilationId,
      workflowId: `${DRAFT_WORKFLOW_PREFIX}${d.definitionId}`,
      input,
      draft: {
        name: d.name,
        capabilityIds: plan.steps.map((s) => s.capabilityId),
        info: {
          definitionId: d.definitionId,
          revision: d.revision,
          path: plan.path,
          branches: plan.branches.map((b) => ({
            nodeId: b.nodeId,
            basis: b.basis,
            capabilityId: b.capabilityId,
            value: b.value,
            threshold: b.threshold,
            taken: b.taken,
          })),
        },
      },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    if (!replayed) {
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.started',
        result: record.status === 'failed' ? 'failed' : record.status === 'waiting_for_human' ? 'escalated' : 'succeeded',
        target: { kind: 'workflow_run', id: record.workflowExecutionId, label: record.workflowName },
        detail: {
          compilationId: record.compilationId,
          workflowId: record.workflowId,
          status: record.status,
          draftId: d.definitionId,
          draftRevision: d.revision,
          steps: plan.steps.length,
          branches: plan.branches.length,
        },
      });
    }
    const viewed = await toWorkflowExecutionView(ctx, record);
    return replayed ? json(200, viewed, { 'idempotent-replayed': 'true' }) : json(202, viewed);
  }

  router.get('/workspaces/:workspaceId/workflow-definitions', guarded(list));
  router.post('/workspaces/:workspaceId/workflow-definitions', guarded(create));
  router.post('/workspaces/:workspaceId/workflow-definitions/validate', guarded(validate));
  router.get('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(get));
  router.put('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(replace));
  router.delete('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(remove));
  router.post('/workspaces/:workspaceId/workflow-definitions/:definitionId/run', guarded(run));
}

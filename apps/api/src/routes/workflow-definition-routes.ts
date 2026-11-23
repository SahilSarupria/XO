import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { loadDraftFacts } from '../workflows/draft-workflow.js';
import { registerRemovedStub } from './removed-stub.js';
import { nodeKindSupport, type DefinitionInput } from '../workflow-definitions/definition.js';
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
    const facts = await loadDraftFacts(
      { workspaceId: w.workspaceId, compilationStore: compilationStore(w), approvalStore: approvalStore(w) },
      compilationIdsOf(input),
    );
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

  async function nodeKinds(req: ApiRequest): Promise<ApiResponse> {
    await requireOwnedWorkspace(req, workspaceStore);
    return json(200, { kinds: nodeKindSupport() });
  }

  router.get('/workspaces/:workspaceId/workflow-definitions/node-kinds', guarded(nodeKinds));
  router.get('/workspaces/:workspaceId/workflow-definitions', guarded(list));
  router.post('/workspaces/:workspaceId/workflow-definitions', guarded(create));
  router.post('/workspaces/:workspaceId/workflow-definitions/validate', guarded(validate));
  router.get('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(get));
  router.put('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(replace));
  router.delete('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(remove));
  // UW-12b (ADR 0052): the draft launcher ran on the removed composed runner.
  registerRemovedStub(
    router,
    'post',
    '/workspaces/:workspaceId/workflow-definitions/:definitionId/run',
    'the Workflow entity routes: generate the workflow from its compilation, certify it, and start it with POST /workspaces/{workspaceId}/workflow-entities/{workflowId}/runs',
    { workspaceStore, dataConfig, permission: 'author', action: 'run a workflow draft (removed)' },
  );
}

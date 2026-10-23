import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
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

const view = (d: WorkflowDefinition) => ({ ...d, analysis: analyzeDefinition(d) });

export function registerWorkflowDefinitionRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const store = (w: WorkspaceRecord) => new FsDefinitionStore(workspaceStateStore(w, dataConfig), w.workspaceId);

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
    return json(200, view(d));
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
    return json(201, view(d));
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
    return json(200, view(d));
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
    await requireOwnedWorkspace(req, workspaceStore);
    const body = await req.json();
    if (!body.ok) throw body.error;
    return json(200, analyzeDefinition(parseDefinitionInput(body.value)));
  }

  /** Honest refusal: there is no executor for user-authored graphs. The analysis says exactly what stands in the way. */
  async function run(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'run workflow definition' });
    const id = req.params['definitionId'] ?? '';
    const d = await store(w).get(id);
    if (d === undefined) throw new NotFoundError(`workflow definition "${id}"`);
    const analysis = analyzeDefinition(d);
    return json(501, {
      error: {
        code: ErrorCode.UNIMPLEMENTED,
        message:
          'Running user-authored workflow graphs is not implemented on this server. Workflows derived from a compilation can be run via /compilations/:id/workflows.',
      },
      analysis,
    });
  }

  router.get('/workspaces/:workspaceId/workflow-definitions', guarded(list));
  router.post('/workspaces/:workspaceId/workflow-definitions', guarded(create));
  router.post('/workspaces/:workspaceId/workflow-definitions/validate', guarded(validate));
  router.get('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(get));
  router.put('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(replace));
  router.delete('/workspaces/:workspaceId/workflow-definitions/:definitionId', guarded(remove));
  router.post('/workspaces/:workspaceId/workflow-definitions/:definitionId/run', guarded(run));
}

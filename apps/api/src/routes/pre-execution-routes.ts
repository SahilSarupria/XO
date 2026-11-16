import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import {
  digestOf,
  goalDigest,
  goalSpecification,
  lowerCandidateWorkflow,
  selectWorkflowScope,
  sourceNamesOf,
  type GoalSpecification,
  type LoweredWorkflow,
  type ScopeSelection,
} from '@xo/pre-execution';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { loadPreExecutionContext } from '../pre-execution/context.js';
import { JsonRecordStore } from '../pre-execution/record-store.js';

/**
 * PX-6 — generated workflows: Workflow IR from a goal (ADR 0029 decision 12). Distinct from the Studio's authored
 * `workflow-definitions` (a person builds those node by node); these are generated from compiled knowledge. A goal selects the candidate workflow (or the caller
 * names one); the candidate is lowered to Workflow IR by the one lowering function every surface uses; the definition is
 * persisted with its digest, so its meaning cannot change silently when the composer changes.
 */

export const WORKFLOW_DEFINITION_RECORD_SCHEMA = 'xo.generated-workflow.v1';

export interface WorkflowDefinitionRecord {
  readonly schema: typeof WORKFLOW_DEFINITION_RECORD_SCHEMA;
  /** `gwf_` + 24 hex of the digest over compilation, candidate, goal and definition. */
  readonly definitionId: string;
  readonly compilationId: string;
  readonly candidateWorkflowId: string;
  readonly workflowName: string;
  readonly goal: GoalSpecification;
  readonly goalDigest: string;
  /** How the candidate was chosen: by the goal (the selection, with its ranking) or named explicitly. */
  readonly selection: ScopeSelection | { readonly status: 'explicit'; readonly workflowId: string };
  readonly lowered: LoweredWorkflow;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly kind: string };
}

const DEFINITION_ID = /^gwf_[0-9a-f]{24}$/;

export function workspaceDefinitionsStore(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
): JsonRecordStore<WorkflowDefinitionRecord> {
  return new JsonRecordStore(
    new LocalFsBlobStore(join(config.dataRootDir, workspace.workspaceId, 'generated-workflows')),
    DEFINITION_ID,
    'generated workflow',
  );
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

/** A goal from a request body, field by field (no extra fields carried into the record). */
export function parseGoal(v: unknown, statedBy: string): GoalSpecification {
  if (typeof v !== 'object' || v === null) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'goal must be { text, needs?, section? }');
  const g = v as Record<string, unknown>;
  if (typeof g['text'] !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'goal.text must be a string');
  if (g['needs'] !== undefined && (!Array.isArray(g['needs']) || !g['needs'].every((n) => typeof n === 'string')))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'goal.needs must be an array of strings');
  if (g['section'] !== undefined && typeof g['section'] !== 'string')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'goal.section must be a string');
  try {
    return goalSpecification({
      text: g['text'],
      ...(g['needs'] !== undefined ? { needs: g['needs'] as string[] } : {}),
      ...(g['section'] !== undefined ? { section: g['section'] as string } : {}),
      ...(g['intake'] === 'text' ? { intake: 'text' as const } : {}),
      ...(typeof g['forEach'] === 'string' ? { forEach: g['forEach'] } : {}),
      statedBy,
    });
  } catch (cause) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, (cause as Error).message);
  }
}

export function registerPreExecutionRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  _audit: AuditService,
): void {
  async function createDefinition(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'generate a workflow definition' });
    const compilationId = req.params['compilationId'];
    if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
    const body = await req.json<{ goal?: unknown; workflowId?: unknown }>();
    if (!body.ok) throw body.error;
    const actor = requirePrincipal(req);
    const goal = parseGoal(body.value.goal, actor.id);
    if (body.value.workflowId !== undefined && typeof body.value.workflowId !== 'string')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'workflowId must be a string');
    const ctx = await loadPreExecutionContext(workspace, dataConfig, compilationId, goal.needs ?? []);

    let selection: WorkflowDefinitionRecord['selection'];
    let candidateId: string;
    if (typeof body.value.workflowId === 'string') {
      candidateId = body.value.workflowId;
      selection = { status: 'explicit', workflowId: candidateId };
    } else {
      const scope = selectWorkflowScope(ctx.workflows, goal);
      if (scope.status !== 'selected') return json(200, { definition: null, selection: scope });
      candidateId = scope.workflowId;
      selection = scope;
    }
    const candidate = ctx.workflows.find((w) => w.id === candidateId);
    if (candidate === undefined) throw new NotFoundError(`workflow "${candidateId}" in compilation "${compilationId}"`);
    const lowered = lowerCandidateWorkflow(ctx.graph, candidate, ctx.inventory, {
      sourceNames: sourceNamesOf(ctx.artifact),
      connectorBindings: ctx.connectorBindings,
      ...(goal.intake !== undefined ? { intake: goal.intake } : {}),
      ...(goal.forEach !== undefined ? { forEach: goal.forEach } : {}),
    });
    const gd = goalDigest(goal);
    const id = digestOf({ compilationId, candidateId, goal: gd, definition: lowered.definitionDigest });
    const record: WorkflowDefinitionRecord = {
      schema: WORKFLOW_DEFINITION_RECORD_SCHEMA,
      definitionId: `gwf_${id.slice(7, 31)}`,
      compilationId,
      candidateWorkflowId: candidate.id,
      workflowName: candidate.name,
      goal,
      goalDigest: gd,
      selection,
      lowered,
      createdAt: new Date().toISOString(),
      createdBy: { id: actor.id, kind: actor.kind },
    };
    const store = workspaceDefinitionsStore(workspace, dataConfig);
    await store.put(record.definitionId, record);
    return json(201, { definition: await store.get(record.definitionId), selection });
  }

  async function listDefinitions(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    return json(200, { definitions: await workspaceDefinitionsStore(workspace, dataConfig).list() });
  }

  async function getDefinition(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    return json(200, await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? ''));
  }

  router.post('/workspaces/:workspaceId/compilations/:compilationId/generated-workflows', guarded(createDefinition));
  router.get('/workspaces/:workspaceId/generated-workflows', guarded(listDefinitions));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId', guarded(getDefinition));
}

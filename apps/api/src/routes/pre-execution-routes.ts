import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import {
  catalogueVersion,
  composeIntent,
  digestOf,
  intentToGoal,
  parseIntentProposal,
  proposalFromModelAnswer,
  reuseKey,
  goalDigest,
  goalSpecification,
  lowerCandidateWorkflow,
  selectWorkflowScope,
  sourceNamesOf,
  type GoalSpecification,
  type IntentFinding,
  type IntentGap,
  type IntentTrace,
  type LoweredWorkflow,
  type ProposalOrigin,
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
import { actorFromPrincipal } from '@xo/audit';
import { checkDataDrift, compiledSchemaDigest, resolveDataReads, type DataRead } from '../drift/data-drift.js';
import { lookupReuse, recordReuse } from '../reuse/definition-reuse.js';
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
  /** UW-6 (ADR 0043): how the intent became this definition (origin, validation findings, catalogue version, selection, lowering), and its digest. */
  readonly intentTrace?: IntentTrace;
  readonly intentTraceDigest?: string;
  /** UW-15 (ADR 0044 amended): tables the workflow reads besides its compilation's sources, with their schema when generated; checked at start. */
  readonly dataReads?: readonly DataRead[];
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

/**
 * Generates (or finds) the Workflow IR for a goal over one compilation: the goal selects the candidate (or `workflowId` names
 * it), the one lowering function produces the definition, and it is persisted under its content-derived id. Shared by the
 * generated-workflow route and the Workflow entity route (UW-2), so a workflow created from a conversation is generated
 * exactly as one created here.
 */
export async function generateDefinition(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  actor: { readonly id: string; readonly kind: string },
  compilationId: string,
  goal: GoalSpecification,
  workflowId: string | undefined,
  origin: ProposalOrigin = 'structured',
  priorFindings: readonly IntentFinding[] = [],
  reads: readonly DataRead[] = [],
): Promise<{
  readonly definition: WorkflowDefinitionRecord | null;
  readonly selection: WorkflowDefinitionRecord['selection'] | ScopeSelection;
  /** UW-6: what the compiled sources cannot provide (a needed capability nothing usable offers, a step with no connector bound). */
  readonly gaps?: readonly IntentGap[];
  /** UW-15: this definition was composed earlier for the same goal, schema, catalogue and bindings; nothing was recomposed. */
  readonly reused?: boolean;
}> {
  const ctx = await loadPreExecutionContext(workspace, dataConfig, compilationId, goal.needs ?? []);
  // UW-15: the same goal over the same schema with the same catalogue reuses the definition composed before instead of recomposing.
  const key = reuseKey({
    goalDigest: goalDigest(goal),
    schemaDigest: await compiledSchemaDigest(workspace, dataConfig, compilationId),
    catalogueVersion: catalogueVersion(ctx.inventory),
    compilationId,
    bindingsDigest: digestOf([...ctx.connectorBindings.values()]),
    ...(workflowId !== undefined ? { workflowId } : {}),
    // A different set of read tables is a different definition (its drift gate differs); absent when none, so earlier keys hold.
    ...(reads.length > 0
      ? { readsDigest: digestOf(reads.map((r) => ({ s: r.sourceId, t: r.recordSetId, f: r.fingerprint.digest }))) }
      : {}),
  });
  const defs = workspaceDefinitionsStore(workspace, dataConfig);
  const hit = await lookupReuse(workspace, dataConfig, key);
  if (hit !== undefined && hit.compilationId === compilationId) {
    const stored = await defs.get(hit.definitionId).catch(() => undefined);
    if (stored !== undefined && stored.lowered.definitionDigest === hit.definitionDigest)
      return { definition: stored, selection: stored.selection, reused: true };
  }
  // UW-6: the intent is composed and validated first; a gap stops here, before anything is generated.
  const intent = composeIntent(
    ctx,
    {
      text: goal.text,
      ...(goal.needs !== undefined ? { needs: goal.needs } : {}),
      ...(goal.section !== undefined ? { section: goal.section } : {}),
      ...(goal.forEach !== undefined ? { forEach: goal.forEach } : {}),
      ...(goal.intake !== undefined ? { intake: goal.intake } : {}),
    },
    origin,
    {
      sourceNames: sourceNamesOf(ctx.artifact),
      connectorBindings: ctx.connectorBindings,
      ...(goal.intake !== undefined ? { intake: goal.intake } : {}),
      ...(goal.forEach !== undefined ? { forEach: goal.forEach } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
      priorFindings,
    },
  );
  // An unbound step is not blocking here: it is generated and reported (`lowered.complete: false`), as before UW-6.
  if (intent.status === 'gap' && intent.gaps.some((g) => g.kind === 'missing_capability'))
    return {
      definition: null,
      selection: { status: 'no_match', reason: 'a needed capability is missing', ranking: [] },
      gaps: intent.gaps,
    };

  let selection: WorkflowDefinitionRecord['selection'];
  let candidateId: string;
  if (workflowId !== undefined) {
    candidateId = workflowId;
    selection = { status: 'explicit', workflowId: candidateId };
  } else {
    const scope = selectWorkflowScope(ctx.workflows, goal);
    if (scope.status !== 'selected') return { definition: null, selection: scope };
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
  const id = digestOf({
    compilationId,
    candidateId,
    goal: gd,
    definition: lowered.definitionDigest,
    ...(reads.length > 0 ? { reads: reads.map((r) => ({ s: r.sourceId, t: r.recordSetId, f: r.fingerprint.digest })) } : {}),
  });
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
    intentTrace: intent.trace,
    intentTraceDigest: intent.traceDigest,
    ...(reads.length > 0 ? { dataReads: reads } : {}),
    createdAt: new Date().toISOString(),
    createdBy: { id: actor.id, kind: actor.kind },
  };
  const store = workspaceDefinitionsStore(workspace, dataConfig);
  await store.put(record.definitionId, record);
  await recordReuse(workspace, dataConfig, key, {
    definitionId: record.definitionId,
    compilationId,
    definitionDigest: lowered.definitionDigest,
  });
  return { definition: await store.get(record.definitionId), selection, reused: false };
}

export function registerPreExecutionRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  async function createDefinition(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'generate a workflow definition' });
    const compilationId = req.params['compilationId'];
    if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
    const body = await req.json<{ goal?: unknown; workflowId?: unknown; reads?: unknown }>();
    if (!body.ok) throw body.error;
    const actor = requirePrincipal(req);
    const goal = parseGoal(body.value.goal, actor.id);
    if (body.value.workflowId !== undefined && typeof body.value.workflowId !== 'string')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'workflowId must be a string');
    const generated = await generateDefinition(
      workspace,
      dataConfig,
      actor,
      compilationId,
      goal,
      typeof body.value.workflowId === 'string' ? body.value.workflowId : undefined,
      'structured',
      [],
      await resolveDataReads(workspace, dataConfig, body.value.reads),
    );
    return json(generated.definition === null ? 200 : 201, generated);
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

  /**
   * UW-6: free text to a workflow, when (and only when) the instance has a proposer. The proposer's answer is untrusted text: it
   * is parsed as a structured proposal and then composed exactly like a person's goal; whatever else it says is never read.
   */
  router.post(
    '/workspaces/:workspaceId/compilations/:compilationId/intent-proposals',
    guarded(async (req) => {
      const workspace = await requireOwnedWorkspace(req, workspaceStore);
      await requirePermission(req, workspace, 'author', dataConfig, { action: 'propose a workflow from free text' });
      const compilationId = req.params['compilationId'];
      if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
      const body = await req.json<{ text?: unknown }>();
      if (!body.ok) throw body.error;
      const text = body.value?.text;
      if (typeof text !== 'string' || text.trim() === '' || text.length > 2000)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'text must be 1 to 2000 characters');
      const proposer = dataConfig.intentProposer;
      if (proposer === undefined)
        throw new XoError(
          ErrorCode.UNIMPLEMENTED,
          'turning free text into a workflow needs a model, and this instance runs with none (strict_local). Give the goal as structured fields instead: POST .../generated-workflows with { goal: { text, needs, section, forEach } }.',
        );
      const actor = requirePrincipal(req);
      const answer = await proposer(text);
      const parsed = parseIntentProposal(proposalFromModelAnswer(typeof answer === 'string' ? answer : ''));
      await audit.tryRecord({
        action: 'intent.propose',
        actor: actorFromPrincipal(actor),
        correlationId: req.headers['x-correlation-id']?.toString() ?? 'intent',
        target: { kind: 'compilation', id: compilationId, workspaceId: workspace.workspaceId },
        type: 'intent.proposed',
        outcome: parsed.proposal === undefined ? 'failed' : 'completed',
        metadata: { findings: parsed.findings.length, needs: parsed.proposal?.needs?.length ?? 0, textLength: text.length },
      });
      if (parsed.proposal === undefined)
        return json(422, { error: 'the model did not return a usable proposal', findings: parsed.findings });
      const generated = await generateDefinition(
        workspace,
        dataConfig,
        actor,
        compilationId,
        intentToGoal(parsed.proposal, actor.id),
        undefined,
        'model',
        parsed.findings,
      );
      return json(generated.definition === null ? 200 : 201, { ...generated, proposal: parsed.proposal, findings: parsed.findings });
    }),
  );

  /** UW-15: has the data this compilation read changed shape? Read-only; the same check a run start applies (ADR 0044). */
  router.get(
    '/workspaces/:workspaceId/compilations/:compilationId/data-drift',
    guarded(async (req) => {
      const workspace = await requireOwnedWorkspace(req, workspaceStore);
      await requirePermission(req, workspace, 'read', dataConfig, { action: 'check data drift' });
      const compilationId = req.params['compilationId'];
      if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
      return json(200, { drift: await checkDataDrift(workspace, dataConfig, compilationId) });
    }),
  );
}

import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceCompilationsStore,
  workspaceExecutionsStore,
  workspaceSourcesStore,
  workspaceStateStore,
  workspaceWorkflowExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { FsWorkflowExecutionStore } from '../workflows/fs-workflow-execution-store.js';
import type { ExecutionRecord } from '../executions/execution.js';
import type { CapabilityProjection } from '../compilations/compilation.js';
import { recordAudit } from '../audit/record.js';
import { FsInfoRequestStore, MAX_INFO_TEXT_LENGTH, type InfoRequest } from '../inbox/info-requests.js';

/**
 * The reviewer's Inbox: a view over the human tasks the execution store already holds (no second store of tasks),
 * joined with the compilation (capability name, confidence, evidence), the source file's name, the workflow run the
 * task belongs to (if any), and the "ask for more info" thread. Every field is read from a record that exists; a
 * field with no source is omitted, never invented.
 */

type InboxState = 'needs_review' | 'done';

function stateOf(record: ExecutionRecord): InboxState {
  return record.humanTask?.status === 'resolved' ? 'done' : 'needs_review';
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

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_INFO_TEXT_LENGTH) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${field}" must be a non-empty string of at most ${MAX_INFO_TEXT_LENGTH} characters`);
  }
  return value.trim();
}

export function registerInboxRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  function stores(workspace: WorkspaceRecord) {
    return {
      executions: new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig)),
      compilations: new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig)),
      sources: new FsSourceStore(workspaceSourcesStore(workspace, dataConfig)),
      workflows: new FsWorkflowExecutionStore(workspaceWorkflowExecutionsStore(workspace, dataConfig)),
      infoRequests: new FsInfoRequestStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId),
    };
  }

  /** Lookup helpers with a per-request cache so a list of N tasks reads each compilation/source once. */
  function makeResolver(s: ReturnType<typeof stores>) {
    const caps = new Map<string, readonly CapabilityProjection[]>();
    const sourceNames = new Map<string, string | undefined>();
    const compilationSource = new Map<string, string | undefined>();
    return {
      async capability(compilationId: string, capabilityId: string): Promise<CapabilityProjection | undefined> {
        if (!caps.has(compilationId)) {
          const found = await s.compilations.getCapabilities(compilationId);
          caps.set(compilationId, found.ok ? found.value : []);
        }
        return caps.get(compilationId)?.find((c) => c.capabilityId === capabilityId);
      },
      async sourceLabel(compilationId: string): Promise<{ sourceId?: string; filename?: string }> {
        if (!compilationSource.has(compilationId)) {
          const c = await s.compilations.get(compilationId);
          compilationSource.set(compilationId, c.ok ? c.value.sourceId : undefined);
        }
        const sourceId = compilationSource.get(compilationId);
        if (sourceId === undefined) return {};
        if (!sourceNames.has(sourceId)) {
          const src = await s.sources.get(sourceId);
          sourceNames.set(sourceId, src.ok ? src.value.originalFilename : undefined);
        }
        const filename = sourceNames.get(sourceId);
        return { sourceId, ...(filename !== undefined ? { filename } : {}) };
      },
    };
  }

  async function workflowLinks(s: ReturnType<typeof stores>) {
    const runs = await s.workflows.list();
    const byTask = new Map<string, { workflowExecutionId: string; workflowName: string; stepIndex: number }>();
    if (runs.ok) {
      for (const run of runs.value) {
        for (const step of run.steps) {
          if (step.executionId !== undefined && step.capabilityId !== undefined) {
            byTask.set(step.executionId, {
              workflowExecutionId: run.workflowExecutionId,
              workflowName: run.workflowName,
              stepIndex: step.order,
            });
          }
        }
      }
    }
    return byTask;
  }

  async function summarize(
    record: ExecutionRecord,
    s: ReturnType<typeof stores>,
    resolver: ReturnType<typeof makeResolver>,
    links: Awaited<ReturnType<typeof workflowLinks>>,
  ) {
    const capability = await resolver.capability(record.compilationId, record.capabilityId);
    const source = await resolver.sourceLabel(record.compilationId);
    const infoRequests = await s.infoRequests.list(record.executionId);
    const link = links.get(record.executionId);
    return {
      executionId: record.executionId,
      state: stateOf(record),
      title: capability?.name ?? record.capabilityId,
      capabilityId: record.capabilityId,
      compilationId: record.compilationId,
      ...(source.sourceId !== undefined ? { sourceId: source.sourceId } : {}),
      ...(source.filename !== undefined ? { sourceFilename: source.filename } : {}),
      ...(capability !== undefined ? { confidence: capability.confidence } : {}),
      requestedAt: record.requestedAt,
      ...(record.completedAt !== undefined ? { waitingSince: record.completedAt } : {}),
      ...(record.humanTask?.resolvedAt !== undefined ? { resolvedAt: record.humanTask.resolvedAt } : {}),
      ...(record.humanTask?.decision !== undefined ? { decision: record.humanTask.decision } : {}),
      ...(record.humanTask?.resolverIdentityId !== undefined ? { resolverIdentityId: record.humanTask.resolverIdentityId } : {}),
      initiatorIdentityId: record.identityId,
      openInfoRequests: infoRequests.filter((r) => r.answer === undefined).length,
      ...(link !== undefined ? { workflow: link } : {}),
    };
  }

  async function listInbox(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const state = req.query.get('state');
    if (state !== null && state !== 'needs_review' && state !== 'done') {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"state" must be "needs_review" or "done"');
    }
    const s = stores(workspace);
    const listed = await s.executions.list();
    if (!listed.ok) throw listed.error;
    const tasks = listed.value.filter((r) => r.humanTask !== undefined);
    const resolver = makeResolver(s);
    const links = await workflowLinks(s);
    const all = await Promise.all(tasks.map((r) => summarize(r, s, resolver, links)));
    // Newest waiting first for the review queue; most recently resolved first for Done.
    const sortKey = (i: (typeof all)[number]) => i.resolvedAt ?? i.waitingSince ?? i.requestedAt;
    all.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
    return json(200, {
      items: state === null ? all : all.filter((i) => i.state === state),
      counts: { needsReview: all.filter((i) => i.state === 'needs_review').length, done: all.filter((i) => i.state === 'done').length },
    });
  }

  async function getInboxItem(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');
    const s = stores(workspace);
    const found = await s.executions.get(executionId);
    if (!found.ok) throw found.error;
    const record = found.value;
    if (record.humanTask === undefined) throw new NotFoundError(`human task "${executionId}"`);
    const resolver = makeResolver(s);
    const links = await workflowLinks(s);
    const summary = await summarize(record, s, resolver, links);
    const capability = await resolver.capability(record.compilationId, record.capabilityId);
    return json(200, {
      ...summary,
      ...(capability !== undefined
        ? {
            capability: {
              id: capability.capabilityId,
              name: capability.name,
              description: capability.description,
              confidence: capability.confidence,
              ...(capability.declaredConfidence !== undefined ? { declaredConfidence: capability.declaredConfidence } : {}),
              evidence: capability.provenance,
            },
          }
        : {}),
      input: record.input,
      /** The runtime's own escalation record (what the capability reported when it asked for a human). */
      escalation: record.output,
      ...(record.humanTask.decisionData !== undefined ? { decisionData: record.humanTask.decisionData } : {}),
      infoRequests: await s.infoRequests.list(executionId),
      trace: {
        ...(record.contractId !== undefined ? { contractId: record.contractId } : {}),
        ...(record.bindingId !== undefined ? { bindingId: record.bindingId } : {}),
        ...(record.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: record.sourceXoirNodeIds } : {}),
        ...(record.graphHash !== undefined ? { graphHash: record.graphHash } : {}),
        ...(record.contractContentHash !== undefined ? { contractContentHash: record.contractContentHash } : {}),
      },
    });
  }

  async function requestInfo(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'request more information' });
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');
    const bodyResult = await req.json<{ question?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const question = text(bodyResult.value?.question, 'question');

    const s = stores(workspace);
    const found = await s.executions.get(executionId);
    if (!found.ok) throw found.error;
    if (found.value.humanTask === undefined) throw new NotFoundError(`human task "${executionId}"`);
    if (found.value.humanTask.status !== 'pending') {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this task is already resolved; more information can no longer be requested');
    }
    const created = await s.infoRequests.open(executionId, question, callerIdentityId(req), new Date());
    if (created === undefined)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'too many unanswered information requests on this task; answer some first');
    await recordAudit(req, workspace, dataConfig, {
      event: 'human_task.info_requested',
      result: 'succeeded',
      target: { kind: 'human_task', id: executionId },
      detail: { requestId: created.requestId },
    });
    return json(201, created satisfies InfoRequest);
  }

  async function answerInfo(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'answer information request' });
    const executionId = req.params['executionId'];
    const requestId = req.params['requestId'];
    if (executionId === undefined || requestId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing id');
    const bodyResult = await req.json<{ answer?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const answer = text(bodyResult.value?.answer, 'answer');
    const s = stores(workspace);
    const found = await s.executions.get(executionId);
    if (!found.ok) throw found.error;
    if (found.value.humanTask === undefined) throw new NotFoundError(`human task "${executionId}"`);
    const result = await s.infoRequests.answer(executionId, requestId, answer, callerIdentityId(req), new Date());
    if (result === 'not_found') throw new NotFoundError(`information request "${requestId}"`);
    if (result === 'already_answered') throw new XoError(ErrorCode.ALREADY_EXISTS, 'this information request already has an answer');
    return json(200, result);
  }

  router.get('/workspaces/:workspaceId/inbox', guarded(listInbox));
  router.get('/workspaces/:workspaceId/inbox/:executionId', guarded(getInboxItem));
  router.post('/workspaces/:workspaceId/inbox/:executionId/info-requests', guarded(requestInfo));
  router.post('/workspaces/:workspaceId/inbox/:executionId/info-requests/:requestId/answer', guarded(answerInfo));
}

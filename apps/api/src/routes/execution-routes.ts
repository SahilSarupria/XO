import { toRecordedAuthentication, type RecordedAuthentication } from '../auth/recorded-authentication.js';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePermission,
  requirePrincipal,
  requireOwnedWorkspace,
  workspaceCompilationsStore,
  workspaceApprovalsStore,
  workspaceExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { recordAudit } from '../audit/record.js';
import { previewCapability } from '../executions/preview-capability.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { isApproved } from '../approvals/approval.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import { createAndRunExecution } from '../executions/run-execution.js';
import type { ExecutionRecord } from '../executions/execution.js';

/**
 * `POST /workspaces/:workspaceId/executions` — the one route in this
 * milestone that actually runs a capability. Every other check
 * (ownership, compilation membership, capability membership, approval,
 * input validation, binding resolution) happens BEFORE
 * `executeApprovedCapability` is ever called — see that function's own
 * doc comment for the runtime bridge itself. This file owns none of the
 * runtime logic; it only sequences the checks the brief enumerates, in
 * the order the brief enumerates them.
 */

function toWireRecord(record: ExecutionRecord): ExecutionRecord {
  return record;
}

interface CreateExecutionBody {
  readonly compilationId?: unknown;
  readonly capabilityId?: unknown;
  readonly input?: unknown;
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

function optionalAuthentication(req: ApiRequest): { authentication?: RecordedAuthentication } {
  const authentication = toRecordedAuthentication(req.authentication);
  return authentication !== undefined ? { authentication } : {};
}

export function registerExecutionRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  /**
   * Validate / Preview — the no-effect half of the Create XO test policy. Allowed on an UNAPPROVED capability
   * (nothing is executed), and reports whether a real Test Run would currently be allowed and why not. Test Run
   * itself is the ordinary POST /executions: same approval gate, same authorization, same audit entry.
   */
  async function previewExecution(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'preview capability' });
    const compilationId = req.params['compilationId'];
    const capabilityId = req.params['capabilityId'];
    if (compilationId === undefined || capabilityId === undefined)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation or capability id');
    const bodyResult = await req.json<{ input?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const input: unknown = bodyResult.value?.input ?? {};

    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const compilation = await compilationStore.get(compilationId);
    if (!compilation.ok) throw compilation.error;
    const caps = await compilationStore.getCapabilities(compilationId);
    if (!caps.ok) throw caps.error;
    if (!caps.value.some((c) => c.capabilityId === capabilityId))
      throw new NotFoundError(`capability "${capabilityId}" in compilation "${compilationId}"`);

    const approval = await new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig)).get(compilationId, capabilityId);
    if (!approval.ok) throw approval.error;
    const approved = isApproved(approval.value);

    const blockers: string[] = [];
    if (compilation.value.status !== 'succeeded')
      blockers.push(`the compilation status is "${compilation.value.status}"; only a succeeded compilation can run`);
    if (!approved) blockers.push('the capability is not approved; a Test Run uses the same approval gate as a production run');

    let preview: ReturnType<typeof previewCapability> | undefined;
    if (compilation.value.status === 'succeeded') {
      const graph = await compilationStore.getCompiledGraph(compilationId);
      if (!graph.ok) throw graph.error;
      preview = previewCapability(graph.value, capabilityId, input);
      if (preview.kind === 'ready' && preview.inputIssues.length > 0) blockers.push('the input does not satisfy the declared input schema');
      if (preview.kind !== 'ready') blockers.push('the capability could not be resolved to a runnable binding');
    }
    return json(200, {
      previewOnly: true,
      note: 'Nothing was executed, no execution record was written and no human task was opened. A passing preview does not prove the real run will succeed.',
      compilationId,
      capabilityId,
      approved,
      testRunAllowed: blockers.length === 0,
      blockers,
      preview: preview ?? null,
    });
  }

  async function createExecution(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'create execution' });

    const bodyResult = await req.json<CreateExecutionBody>();
    if (!bodyResult.ok) throw bodyResult.error;
    const body = bodyResult.value;
    if (typeof body.compilationId !== 'string' || body.compilationId.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"compilationId" (string) is required');
    }
    if (typeof body.capabilityId !== 'string' || body.capabilityId.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"capabilityId" (string) is required');
    }
    // No "runtime declaration", "execution class", or "identityId" field
    // is ever read from this body — there is nothing here for a client
    // to override with (see the milestone brief's "never accept ...
    // runtime declarations ... from the client" and this file's own
    // completion-report section on the same point).
    const input: unknown = body.input ?? {};

    const compilationId = body.compilationId;
    const capabilityId = body.capabilityId;
    const completed = await createAndRunExecution(
      { workspace, dataConfig, principal: requirePrincipal(req), ...optionalAuthentication(req) },
      { compilationId, capabilityId, input },
    );
    await recordAudit(req, workspace, dataConfig, {
      event: 'execution.created',
      result: completed.status === 'failed' ? 'failed' : completed.status === 'waiting_for_human' ? 'escalated' : 'succeeded',
      target: { kind: 'execution', id: completed.executionId },
      detail: { compilationId, capabilityId, status: completed.status },
    });

    // A failed/unresolved/invalid-input execution is still a real,
    // structured, successfully-persisted API response ABOUT that
    // outcome — never a bare 4xx/5xx that discards the execution record
    // itself. Only genuinely exceptional conditions (unowned workspace,
    // unknown compilation/capability, not approved) short-circuit before
    // an `ExecutionRecord` is ever created.
    return json(completed.status === 'failed' ? 200 : 201, toWireRecord(completed));
  }

  async function listExecutions(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    return json(200, { executions: listed.value.map(toWireRecord) });
  }

  async function getExecution(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');
    const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const found = await store.get(executionId);
    if (!found.ok) throw found.error;
    return json(200, toWireRecord(found.value));
  }

  router.post('/workspaces/:workspaceId/executions', guarded(createExecution));
  router.post('/workspaces/:workspaceId/compilations/:compilationId/capabilities/:capabilityId/preview', guarded(previewExecution));
  router.get('/workspaces/:workspaceId/executions', guarded(listExecutions));
  router.get('/workspaces/:workspaceId/executions/:executionId', guarded(getExecution));
}

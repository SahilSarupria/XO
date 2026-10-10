import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePrincipal,
  requireOwnedWorkspace,
  workspaceCompilationsStore,
  workspaceApprovalsStore,
  workspaceExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { isApproved } from '../approvals/approval.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import type { PermissionManager } from '@xo/permissions';
import { executeApprovedCapability, preflightCapabilityAuthorization } from '../executions/execute-capability.js';
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

export function registerExecutionRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
): void {
  async function createExecution(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);

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

    // 3. Verify compilation and capability ownership.
    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const compilationFound = await compilationStore.get(compilationId);
    if (!compilationFound.ok) throw compilationFound.error;
    if (compilationFound.value.status !== 'succeeded') {
      throw new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `compilation "${compilationId}" has status "${compilationFound.value.status}" — only a succeeded compilation can be executed against`,
      );
    }

    const capsFound = await compilationStore.getCapabilities(compilationId);
    if (!capsFound.ok) throw capsFound.error;
    const capability = capsFound.value.find((c) => c.capabilityId === capabilityId);
    if (capability === undefined) throw new NotFoundError(`capability "${capabilityId}" in compilation "${compilationId}"`);

    // 4. Verify the capability is approved.
    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const approval = await approvalStore.get(compilationId, capabilityId);
    if (!approval.ok) throw approval.error;
    if (!isApproved(approval.value)) {
      throw new XoError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        `capability "${capabilityId}" is not approved for execution in workspace "${workspace.workspaceId}"`,
      );
    }

    // 6. Resolve the authoritative runtime declaration from the STORED
    // compilation result (never a fresh recompile, never a client-
    // supplied declaration) — the compiled graph this compilation
    // persisted (P0.5 addition to P0.4's result, see
    // `compilations/compilation.ts`).
    const graphFound = await compilationStore.getCompiledGraph(compilationId);
    if (!graphFound.ok) throw graphFound.error;

    const principal = requirePrincipal(req);

    // 6b. P1.0 M2 — AUTHORIZE BEFORE ANY SIDE EFFECT. The decision is made here, against the authoritative
    // declaration on the STORED graph and the server-side policy, BEFORE `ExecutionStore.create`. A denied
    // (or undecidable) attempt is rejected with no persistent record, no handler call and no state change, so
    // an authenticated-but-unauthorized caller cannot grow the store. This preflight is NOT the security
    // boundary: `executeApprovedCapability` below re-authorizes at the execution boundary, tied to the same
    // graph (`preflightGraphHash`).
    const preflight = await preflightCapabilityAuthorization(graphFound.value, capabilityId, { subject: principal, permissionManager });
    if (preflight.kind !== 'authorized') {
      throw new XoError(
        preflight.kind === 'denied' ? ErrorCode.RUNTIME_PERMISSION_DENIED : (preflight.errorCode as ErrorCode),
        preflight.errorMessage,
      );
    }

    const executionStore = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const created = await executionStore.create(workspace.workspaceId, principal, { compilationId, capabilityId, input });
    if (!created.ok) throw created.error;

    // 5 (input validation) + 7 (invoke) both happen inside
    // `executeApprovedCapability` — see its own doc comment for exactly
    // why input-schema validation has to happen after binding
    // resolution, not before, in this particular call sequence.
    const outcome = await executeApprovedCapability(
      graphFound.value,
      capabilityId,
      input,
      { subject: principal, permissionManager },
      { preflightGraphHash: preflight.graphHash },
    );

    let completed;
    switch (outcome.kind) {
      case 'succeeded':
      case 'waiting_for_human':
        completed = await executionStore.complete(created.value.executionId, {
          status: outcome.kind,
          output: outcome.output,
          ...(outcome.contractId !== undefined ? { contractId: outcome.contractId } : {}),
          ...(outcome.bindingId !== undefined ? { bindingId: outcome.bindingId } : {}),
          ...(outcome.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: outcome.sourceXoirNodeIds } : {}),
          ...(outcome.graphHash !== undefined ? { graphHash: outcome.graphHash } : {}),
          ...(outcome.contractContentHash !== undefined ? { contractContentHash: outcome.contractContentHash } : {}),
        });
        break;
      case 'invalid_input':
        completed = await executionStore.complete(created.value.executionId, {
          status: 'failed',
          errorCode: ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID,
          errorMessage: `input validation failed: ${outcome.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ')}`,
        });
        break;
      case 'unresolved': {
        const codeByStatus: Record<'unresolved' | 'ambiguous' | 'denied', string> = {
          unresolved: ErrorCode.BINDING_UNRESOLVED,
          ambiguous: ErrorCode.BINDING_AMBIGUOUS,
          denied: ErrorCode.BINDING_DENIED,
        };
        completed = await executionStore.complete(created.value.executionId, {
          status: 'failed',
          errorCode: codeByStatus[outcome.status],
          errorMessage: outcome.reason,
        });
        break;
      }
      case 'error':
        completed = await executionStore.complete(created.value.executionId, {
          status: 'failed',
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        });
        break;
    }
    if (!completed.ok) throw completed.error;

    // A failed/unresolved/invalid-input execution of an AUTHORIZED caller is still a real,
    // structured, successfully-persisted API response ABOUT that
    // outcome — never a bare 4xx/5xx that discards the execution record
    // itself. Only genuinely exceptional conditions (unowned workspace,
    // unknown compilation/capability, not approved, NOT AUTHORIZED —
    // P1.0 M2) short-circuit before an `ExecutionRecord` is ever created.
    return json(completed.value.status === 'failed' ? 200 : 201, toWireRecord(completed.value));
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
  router.get('/workspaces/:workspaceId/executions', guarded(listExecutions));
  router.get('/workspaces/:workspaceId/executions/:executionId', guarded(getExecution));
}

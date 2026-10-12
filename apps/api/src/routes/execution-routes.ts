import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePrincipal,
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
import { actorFromPrincipal, type AuditEventDraft, type AuditEventType } from '@xo/audit';
import {
  type AuditService,
  auditedOwnedWorkspace,
  auditedRead,
  finalizationNotice,
  newCorrelationId,
  safeId,
} from '../audit/audit-service.js';

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
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  async function createExecution(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'execute.capability', correlationId });

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

    const principal = requirePrincipal(req);
    const actor = actorFromPrincipal(principal);
    const capabilityTarget = safeId(capabilityId);
    const baseDraft = {
      action: 'execute.capability',
      actor,
      correlationId,
      ...(capabilityTarget !== undefined
        ? { target: { kind: 'capability' as const, id: capabilityTarget, workspaceId: workspace.workspaceId } }
        : { target: { kind: 'workspace' as const, id: workspace.workspaceId } }),
      ...(safeId(compilationId) !== undefined ? { metadata: { compilationId } } : {}),
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;

    // 4. Verify the capability is approved.
    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const approval = await approvalStore.get(compilationId, capabilityId);
    if (!approval.ok) throw approval.error;
    if (!isApproved(approval.value)) {
      await audit.tryRecord({ ...baseDraft, type: 'execution.denied', outcome: 'denied', reasonCode: ErrorCode.RUNTIME_PERMISSION_DENIED });
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

    // 6b. P1.0 M2 — AUTHORIZE BEFORE ANY SIDE EFFECT. The decision is made here, against the authoritative
    // declaration on the STORED graph and the server-side policy, BEFORE `ExecutionStore.create`. A denied
    // (or undecidable) attempt is rejected with no persistent record, no handler call and no state change, so
    // an authenticated-but-unauthorized caller cannot grow the store. This preflight is NOT the security
    // boundary: `executeApprovedCapability` below re-authorizes at the execution boundary, tied to the same
    // graph (`preflightGraphHash`).
    const preflight = await preflightCapabilityAuthorization(graphFound.value, capabilityId, { subject: principal, permissionManager });
    if (preflight.kind !== 'authorized') {
      // P1.0 M4 — record the denial (best effort: the denial is enforced whether or not the record could be written).
      await audit.tryRecord({
        ...baseDraft,
        type: preflight.kind === 'denied' ? 'execution.denied' : 'authorization.denied',
        outcome: preflight.kind === 'denied' ? 'denied' : 'failed',
        reasonCode: preflight.kind === 'denied' ? ErrorCode.RUNTIME_PERMISSION_DENIED : String(preflight.errorCode),
      });
      throw new XoError(
        preflight.kind === 'denied' ? ErrorCode.RUNTIME_PERMISSION_DENIED : (preflight.errorCode as ErrorCode),
        preflight.errorMessage,
      );
    }

    // P1.0 M4 — PRECONDITION: authorized, so durably record that execution is being started BEFORE any record is
    // created or the capability runs. If this cannot be confirmed the whole operation is refused (AUDIT_UNAVAILABLE,
    // 503): no execution record, no handler call, no side effect.
    await audit.requireDurable({ ...baseDraft, type: 'execution.started', outcome: 'started' });

    const executionStore = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const created = await executionStore.create(workspace.workspaceId, principal, { compilationId, capabilityId, input });
    if (!created.ok) throw created.error;

    // 5 (input validation) + 7 (invoke) both happen inside
    // `executeApprovedCapability` — see its own doc comment for exactly
    // why input-schema validation has to happen after binding
    // resolution, not before, in this particular call sequence.
    let outcome;
    try {
      outcome = await executeApprovedCapability(
        graphFound.value,
        capabilityId,
        input,
        { subject: principal, permissionManager },
        { preflightGraphHash: preflight.graphHash, preflightDeclarationFingerprint: preflight.declarationFingerprint },
      );
    } catch (cause) {
      // An unexpected throw after the start record: say so (best effort), then surface the original error unchanged.
      await audit.finalize(
        {
          ...baseDraft,
          type: 'execution.failed',
          outcome: 'failed',
          reasonCode: cause instanceof XoError ? cause.code : ErrorCode.UNKNOWN,
          executionId: created.value.executionId,
        },
        { correlationId, executionId: created.value.executionId },
      );
      throw cause;
    }

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
    if (!completed.ok) {
      // The capability already ran but its result could not be persisted — record that truthfully, then surface the error.
      await audit.finalize(
        {
          ...baseDraft,
          type: 'execution.failed',
          outcome: 'failed',
          reasonCode: completed.error.code,
          executionId: created.value.executionId,
        },
        { correlationId, executionId: created.value.executionId },
      );
      throw completed.error;
    }
    // P1.0 M4 — COMPLETION evidence. The operation has ALREADY happened; if this write fails we report the real
    // outcome plus a sanitized `auditFinalization` notice (correlation + execution id) and NEVER retry the side effect.
    const finalType: AuditEventType =
      completed.value.status === 'succeeded'
        ? 'execution.completed'
        : completed.value.status === 'waiting_for_human'
          ? 'execution.waiting_for_human'
          : 'execution.failed';
    const finalization = await audit.finalize(
      {
        ...baseDraft,
        type: finalType,
        outcome: completed.value.status === 'failed' ? 'failed' : 'completed',
        executionId: completed.value.executionId,
        ...(completed.value.status === 'failed' &&
        completed.value.errorCode !== undefined &&
        safeId(completed.value.errorCode) !== undefined
          ? { reasonCode: completed.value.errorCode }
          : {}),
      },
      { correlationId, executionId: completed.value.executionId },
    );

    // A failed/unresolved/invalid-input execution of an AUTHORIZED caller is still a real,
    // structured, successfully-persisted API response ABOUT that
    // outcome — never a bare 4xx/5xx that discards the execution record
    // itself. Only genuinely exceptional conditions (unowned workspace,
    // unknown compilation/capability, not approved, NOT AUTHORIZED —
    // P1.0 M2) short-circuit before an `ExecutionRecord` is ever created.
    return json(completed.value.status === 'failed' ? 200 : 201, { ...toWireRecord(completed.value), ...finalizationNotice(finalization) });
  }

  async function listExecutions(req: ApiRequest): Promise<ApiResponse> {
    // P1.0 M4 — protected read: owner check -> durable `access.attempted` -> only then read.
    return auditedRead(req, auditCtx, { action: 'list.executions', kind: 'execution' }, async (workspace) => {
      const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
      const listed = await store.list();
      if (!listed.ok) throw listed.error;
      return json(200, { executions: listed.value.map(toWireRecord) });
    });
  }

  async function getExecution(req: ApiRequest): Promise<ApiResponse> {
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');
    return auditedRead(req, auditCtx, { action: 'get.execution', kind: 'execution', idParam: 'executionId' }, async (workspace) => {
      const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
      const found = await store.get(executionId);
      if (!found.ok) throw found.error;
      return json(200, toWireRecord(found.value));
    });
  }

  router.post('/workspaces/:workspaceId/executions', guarded(createExecution));
  router.get('/workspaces/:workspaceId/executions', guarded(listExecutions));
  router.get('/workspaces/:workspaceId/executions/:executionId', guarded(getExecution));
}

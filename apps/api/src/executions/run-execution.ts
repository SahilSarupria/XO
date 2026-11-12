import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal, type AuditEventDraft, type AuditEventType } from '@xo/audit';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import type { RecordedAuthentication } from '../auth/recorded-authentication.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { deriveCapabilityApprovalStateFromJson } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import type { AuditService } from '../audit/audit-service.js';
import { newCorrelationId, safeId } from '../audit/audit-service.js';
import { FsExecutionStore } from './fs-execution-store.js';
import { executeApprovedCapability, preflightCapabilityAuthorization } from './execute-capability.js';
import type { ExecutionRecord } from './execution.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import {
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceExecutionsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';

export interface RunExecutionContext {
  readonly workspace: WorkspaceRecord;
  readonly dataConfig: WorkspaceDataConfig;
  readonly principal: AuthenticatedPrincipal;
  readonly authentication?: RecordedAuthentication;
  /** P1.0 M2 — the server-side policy decision point. Required: a capability cannot be run without an authorization decision. */
  readonly permissionManager: PermissionManager;
  /** P1.0 M4 — the audit service. Required: execution evidence is written before the run starts and after it ends. */
  readonly audit: AuditService;
}

/**
 * Runs a capability for a saved test case through the SAME enforcement chain as `POST /executions`: compilation and capability
 * membership, the material-state-bound approval (P1.0 M3), authorization before any side effect (M2), durable start evidence (M4),
 * binding resolution, input validation and the runtime bridge, persisted as an ExecutionRecord with completion evidence. Throws the
 * same errors the route always threw; a failed run is still a returned, persisted record.
 */
export async function createAndRunExecution(
  ctx: RunExecutionContext,
  request: { readonly compilationId: string; readonly capabilityId: string; readonly input: unknown },
): Promise<ExecutionRecord> {
  const { workspace, dataConfig } = ctx;
  const { compilationId, capabilityId, input } = request;

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

  // 6. Resolve the authoritative runtime declaration from the STORED compilation result (never a fresh recompile).
  const graphFound = await compilationStore.getCompiledGraph(compilationId);
  if (!graphFound.ok) throw graphFound.error;

  const correlationId = newCorrelationId();
  const capabilityTarget = safeId(capabilityId);
  const baseDraft = {
    action: 'execute.capability',
    actor: actorFromPrincipal(ctx.principal),
    correlationId,
    ...(capabilityTarget !== undefined
      ? { target: { kind: 'capability' as const, id: capabilityTarget, workspaceId: workspace.workspaceId } }
      : { target: { kind: 'workspace' as const, id: workspace.workspaceId } }),
    ...(safeId(compilationId) !== undefined ? { metadata: { compilationId } } : {}),
  } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;

  // 4. The capability must be approved FOR ITS CURRENT STATE, derived from the very graph that is about to execute.
  const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
  const verdict = await verifyApproval(
    approvalStore,
    { workspaceId: workspace.workspaceId, compilationId, capabilityId },
    deriveCapabilityApprovalStateFromJson(graphFound.value, capabilityId, compilationFound.value.sourceDigestSha256),
  );
  if (!verdict.ok) throw verdict.error;
  if (!verdict.value.approved) {
    await ctx.audit.tryRecord({ ...baseDraft, type: 'execution.denied', outcome: 'denied', reasonCode: verdict.value.reasonCode });
    throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, verdict.value.message);
  }

  // 4b. AUTHORIZE BEFORE ANY SIDE EFFECT (and before an execution record exists).
  const subject = { subject: ctx.principal, permissionManager: ctx.permissionManager };
  const preflight = await preflightCapabilityAuthorization(graphFound.value, capabilityId, subject);
  if (preflight.kind !== 'authorized') {
    await ctx.audit.tryRecord({
      ...baseDraft,
      type: preflight.kind === 'denied' ? 'execution.denied' : 'authorization.denied',
      outcome: preflight.kind === 'denied' ? 'denied' : 'failed',
      reasonCode: String(preflight.errorCode),
    });
    throw new XoError(preflight.errorCode as ErrorCode, preflight.errorMessage);
  }

  // PRECONDITION: durable evidence that execution is starting. If it cannot be confirmed nothing runs.
  await ctx.audit.requireDurable({ ...baseDraft, type: 'execution.started', outcome: 'started' });

  const executionStore = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
  const created = await executionStore.create(workspace.workspaceId, ctx.principal, {
    compilationId,
    capabilityId,
    input,
    ...(ctx.authentication !== undefined ? { authentication: ctx.authentication } : {}),
  });
  if (!created.ok) throw created.error;

  // 5 (input validation) + 7 (invoke) both happen inside
  // `executeApprovedCapability` — see its own doc comment for exactly
  // why input-schema validation has to happen after binding
  // resolution, not before, in this particular call sequence.
  let outcome;
  try {
    outcome = await executeApprovedCapability(graphFound.value, capabilityId, input, subject, {
      preflightGraphHash: preflight.graphHash,
      preflightDeclarationFingerprint: preflight.declarationFingerprint,
    });
  } catch (cause) {
    await ctx.audit.finalize(
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
    await ctx.audit.finalize(
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
  // COMPLETION evidence: the run already happened, so a failed write here is reported, never retried.
  const finalType: AuditEventType =
    completed.value.status === 'succeeded'
      ? 'execution.completed'
      : completed.value.status === 'waiting_for_human'
        ? 'execution.waiting_for_human'
        : 'execution.failed';
  await ctx.audit.finalize(
    {
      ...baseDraft,
      type: finalType,
      outcome: completed.value.status === 'failed' ? 'failed' : 'completed',
      executionId: completed.value.executionId,
      ...(completed.value.status === 'failed' && completed.value.errorCode !== undefined && safeId(completed.value.errorCode) !== undefined
        ? { reasonCode: completed.value.errorCode }
        : {}),
    },
    { correlationId, executionId: completed.value.executionId },
  );
  return completed.value;
}

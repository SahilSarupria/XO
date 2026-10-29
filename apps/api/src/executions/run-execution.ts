import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import type { RecordedAuthentication } from '../auth/recorded-authentication.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { isApproved } from '../approvals/approval.js';
import { FsExecutionStore } from './fs-execution-store.js';
import { executeApprovedCapability } from './execute-capability.js';
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
}

/**
 * The one place a capability execution is created and run for a route: compilation and capability membership, the
 * approval gate, binding resolution, input validation and the unmodified runtime bridge, persisted as an
 * ExecutionRecord. `POST /executions` and saved test-case runs both call it, so they cannot drift apart. Throws the
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
  const outcome = await executeApprovedCapability(graphFound.value, capabilityId, input);

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
  return completed.value;
}

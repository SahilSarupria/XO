import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { err } from '@xo/types';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requireOwnedWorkspace,
  workspaceSourcesStore,
  workspaceCompilationsStore,
  workspaceApprovalsStore,
  requirePrincipal,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { compileSourceRecord } from '../compilations/compile-source.js';
import type { CompilationRecord, CapabilityProjection } from '../compilations/compilation.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { APPROVAL_REASON_CODES } from '../approvals/approval.js';
import { deriveCapabilityApprovalStateFromJson } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, finalizationNotice, newCorrelationId, safeId } from '../audit/audit-service.js';
import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';

/**
 * Source -> compilation -> capability, over the exact same
 * `requireOwnedWorkspace` ownership boundary every other workspace-bound
 * route family already uses. Compilation itself runs synchronously
 * inside `POST .../compile` — see `compile-source.ts`'s doc comment and
 * this milestone's completion report for why that's an honest choice
 * here, not a shortcut being hidden. There is no polling for a
 * `'running'` status this API will ever actually observe.
 */

function toWireRecord(record: CompilationRecord): CompilationRecord {
  return record;
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

export function registerCompilationRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };
  async function compile(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');

    // Resolve and authorize the source through the trusted, already
    // workspace-scoped `SourceStore` (P0.3) — a 404 here (unknown source,
    // or a source belonging to a different workspace, which cannot even
    // be looked up through this workspace's own store) happens before
    // any compiler call, exactly like every other route family's
    // ownership check.
    const sourceStore = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const sourceFound = await sourceStore.get(sourceId);
    if (!sourceFound.ok) throw sourceFound.error;
    const source = sourceFound.value;

    const contentFound = await sourceStore.getContent(sourceId);
    if (!contentFound.ok) {
      // "Missing source content" (metadata exists, bytes don't — e.g. a
      // half-finished delete) is a storage-integrity problem, not a
      // compiler failure: there is nothing to persist a `'failed'`
      // compilation record *about*, since we never even got bytes to
      // hand the compiler. Fails closed as 404, same posture P0.3's own
      // `.../content` route already takes for this exact condition.
      throw new NotFoundError(`source "${sourceId}" content`);
    }

    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));

    // Every compile request creates a new compilation record — see the
    // completion report's "idempotency and repeat compilation" section
    // for why this (rather than reusing an existing result for the same
    // source digest) is this milestone's deliberate, documented choice.
    const created = await compilationStore.create(workspace.workspaceId, workspace.identityId, {
      sourceId,
      sourceDigestSha256: source.digestSha256,
    });
    if (!created.ok) throw created.error;

    // Synchronous: by the time this call returns, `compileSourceRecord`
    // has already called `markSucceeded`/`markFailed` — see that
    // function's own doc comment. The HTTP response always reports the
    // finished (`succeeded`/`failed`) status, never `running`.
    await compileSourceRecord(compilationStore, created.value.compilationId, source, contentFound.value);

    const finished = await compilationStore.get(created.value.compilationId);
    if (!finished.ok) throw finished.error;

    return json(finished.value.status === 'succeeded' ? 201 : 200, toWireRecord(finished.value));
  }

  async function listCompilations(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    return json(200, { compilations: listed.value.map(toWireRecord) });
  }

  async function getCompilation(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const compilationId = req.params['compilationId'];
    if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
    const store = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const found = await store.get(compilationId);
    if (!found.ok) throw found.error;
    return json(200, toWireRecord(found.value));
  }

  async function getCapabilities(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const compilationId = req.params['compilationId'];
    if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
    const store = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const found = await store.getCapabilities(compilationId);
    if (!found.ok) throw found.error;

    // Each capability's approval status. Since P1.0 M3 `approved` means "approved FOR ITS CURRENT STATE": it is the same
    // `verifyApproval` verdict the execution boundary reaches, so this projection can never say `true` for something the
    // boundary would refuse. `approvalStatus` adds the precise reason (e.g. `stale`) for a capability that is not approved.
    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const compilationRecord = await store.get(compilationId);
    if (!compilationRecord.ok) throw compilationRecord.error;
    const graphJson = await store.getCompiledGraph(compilationId);
    const withApproval = await Promise.all(
      found.value.map(async (cap: CapabilityProjection) => {
        const current = graphJson.ok
          ? deriveCapabilityApprovalStateFromJson(graphJson.value, cap.capabilityId, compilationRecord.value.sourceDigestSha256)
          : err(graphJson.error);
        const verdict = await verifyApproval(
          approvalStore,
          { workspaceId: workspace.workspaceId, compilationId, capabilityId: cap.capabilityId },
          current,
        );
        const approved = verdict.ok && verdict.value.approved;
        const approvalStatus = !verdict.ok ? 'unavailable' : verdict.value.approved ? 'approved' : verdict.value.reason;
        return { ...cap, approved, approvalStatus };
      }),
    );

    return json(200, { compilationId, capabilities: withApproval });
  }

  async function approveCapability(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'approve.capability', correlationId });
    const compilationId = req.params['compilationId'];
    const capabilityId = req.params['capabilityId'];
    if (compilationId === undefined || capabilityId === undefined)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation or capability id');

    // P1.0 M3 — ATTRIBUTION: the approver is the authenticated principal (M1), re-verified at runtime. There is no body field,
    // header or query parameter through which an approver, a binding or a target version can be supplied.
    const approver = requirePrincipal(req);
    const capabilityTarget = safeId(capabilityId);
    const baseDraft = {
      action: 'approve.capability',
      actor: actorFromPrincipal(approver),
      correlationId,
      ...(capabilityTarget !== undefined
        ? { target: { kind: 'capability' as const, id: capabilityTarget, workspaceId: workspace.workspaceId } }
        : { target: { kind: 'workspace' as const, id: workspace.workspaceId } }),
      ...(safeId(compilationId) !== undefined ? { metadata: { compilationId } } : {}),
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    const deny = async (reasonCode: string): Promise<void> => {
      await audit.tryRecord({ ...baseDraft, type: 'approval.denied', outcome: 'denied', reasonCode });
    };

    // "Verify the capability belongs to the compilation" — checked against the compilation's own persisted capability list
    // (P0.4), never assumed from the URL alone.
    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const compilationFound = await compilationStore.get(compilationId);
    if (!compilationFound.ok) throw compilationFound.error;
    if (compilationFound.value.status !== 'succeeded') {
      await deny(ErrorCode.INVALID_ARGUMENT);
      throw new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `compilation "${compilationId}" has status "${compilationFound.value.status}" — only a succeeded compilation's capabilities can be approved`,
      );
    }
    const capsFound = await compilationStore.getCapabilities(compilationId);
    if (!capsFound.ok) throw capsFound.error;
    const capability = capsFound.value.find((c) => c.capabilityId === capabilityId);
    if (capability === undefined) throw new NotFoundError(`capability "${capabilityId}" in compilation "${compilationId}"`);

    // BINDING: derive the capability's CURRENT material state from the PERSISTED graph on the server. What is approved is
    // exactly this derived state — the client cannot name a different one. A capability whose contract cannot be built has no
    // approvable state and is refused.
    const graphFound = await compilationStore.getCompiledGraph(compilationId);
    if (!graphFound.ok) throw graphFound.error;
    const state = deriveCapabilityApprovalStateFromJson(graphFound.value, capabilityId, compilationFound.value.sourceDigestSha256);
    if (!state.ok) {
      await deny(APPROVAL_REASON_CODES.state_unavailable);
      throw state.error;
    }

    // M4 PRECONDITION: durable evidence that an approval is being granted, BEFORE it is stored. If it cannot be confirmed the
    // approval is not created (fail closed).
    await audit.requireDurable({
      ...baseDraft,
      type: 'approval.attempted',
      outcome: 'attempted',
      metadata: {
        ...(safeId(compilationId) !== undefined ? { compilationId } : {}),
        stateDigestPrefix: state.value.stateDigest.slice(0, 23),
      },
    });

    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const approved = await approvalStore.approve({
      compilationId,
      capabilityId,
      workspaceId: workspace.workspaceId,
      approver: { kind: approver.kind, id: approver.id, ...(approver.orgId !== undefined ? { orgId: approver.orgId } : {}) },
      binding: {
        stateDigest: state.value.stateDigest,
        contractId: state.value.contractId,
        contractContentHash: state.value.contractContentHash,
        declarationFingerprint: state.value.declarationFingerprint,
        implementationClass: state.value.implementationClass,
        bindingId: state.value.bindingId,
        sourceDigestSha256: state.value.sourceDigestSha256,
      },
    });
    if (!approved.ok) throw approved.error;

    const finalization = await audit.finalize(
      {
        ...baseDraft,
        type: 'approval.granted',
        outcome: 'completed',
        metadata: {
          ...(safeId(compilationId) !== undefined ? { compilationId } : {}),
          stateDigestPrefix: state.value.stateDigest.slice(0, 23),
        },
      },
      { correlationId },
    );
    return json(200, { ...approved.value, ...finalizationNotice(finalization) });
  }

  router.post('/workspaces/:workspaceId/sources/:sourceId/compile', guarded(compile));
  router.get('/workspaces/:workspaceId/compilations', guarded(listCompilations));
  router.get('/workspaces/:workspaceId/compilations/:compilationId', guarded(getCompilation));
  router.get('/workspaces/:workspaceId/compilations/:compilationId/capabilities', guarded(getCapabilities));
  router.post('/workspaces/:workspaceId/compilations/:compilationId/capabilities/:capabilityId/approve', guarded(approveCapability));
}

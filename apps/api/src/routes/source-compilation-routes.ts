import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, workspaceSourcesStore, workspaceCompilationsStore, workspaceApprovalsStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { compileSourceRecord } from '../compilations/compile-source.js';
import type { CompilationRecord, CapabilityProjection } from '../compilations/compilation.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { isApproved } from '../approvals/approval.js';

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

export function registerCompilationRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
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
    const created = await compilationStore.create(workspace.workspaceId, workspace.identityId, { sourceId, sourceDigestSha256: source.digestSha256 });
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

    // P0.5: each capability's approval status, reusing the same
    // per-capability `ApprovalStore.get` the approve route itself uses —
    // "approval fields added to the existing capability projection",
    // per the milestone brief's own wording for which of its two options
    // to pick.
    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const withApproval = await Promise.all(
      found.value.map(async (cap: CapabilityProjection) => {
        const approval = await approvalStore.get(compilationId, cap.capabilityId);
        return { ...cap, approved: approval.ok ? isApproved(approval.value) : false };
      }),
    );

    return json(200, { compilationId, capabilities: withApproval });
  }

  async function approveCapability(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const compilationId = req.params['compilationId'];
    const capabilityId = req.params['capabilityId'];
    if (compilationId === undefined || capabilityId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation or capability id');

    // "Verify the capability belongs to the compilation" — checked
    // against the compilation's own persisted capability list (P0.4),
    // never assumed from the URL alone. A capabilityId that isn't one of
    // this compilation's own discovered capabilities is a 404, exactly
    // like an unknown compilation would be — not a 400, since the id
    // itself may well be syntactically fine, it just doesn't belong here.
    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const capsFound = await compilationStore.getCapabilities(compilationId);
    if (!capsFound.ok) throw capsFound.error;
    const capability = capsFound.value.find((c) => c.capabilityId === capabilityId);
    if (capability === undefined) throw new NotFoundError(`capability "${capabilityId}" in compilation "${compilationId}"`);

    const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
    const approved = await approvalStore.approve(compilationId, capabilityId, workspace.workspaceId, workspace.identityId);
    if (!approved.ok) throw approved.error;

    return json(200, approved.value);
  }

  router.post('/workspaces/:workspaceId/sources/:sourceId/compile', guarded(compile));
  router.get('/workspaces/:workspaceId/compilations', guarded(listCompilations));
  router.get('/workspaces/:workspaceId/compilations/:compilationId', guarded(getCompilation));
  router.get('/workspaces/:workspaceId/compilations/:compilationId/capabilities', guarded(getCapabilities));
  router.post('/workspaces/:workspaceId/compilations/:compilationId/capabilities/:capabilityId/approve', guarded(approveCapability));
}

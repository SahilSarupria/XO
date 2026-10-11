import { ErrorCode, XoError, NotFoundError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePrincipal,
  requireOwnedWorkspace,
  workspaceExecutionsStore,
  workspaceCompilationsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsExecutionStore } from '../executions/fs-execution-store.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import type { PermissionManager } from '@xo/permissions';
import { resolveHumanTaskExecution } from '../executions/resolve-human-task.js';
import type { ExecutionRecord, HumanTaskDecision } from '../executions/execution.js';

/**
 * `human-tasks` is a VIEW over the same execution records P0.5's
 * `execution-routes.ts` already owns (`ExecutionRecord.humanTask`) — not
 * a second store, not a second source of truth (per the milestone
 * brief's explicit "reuse the existing execution store and avoid
 * duplicate sources of truth"). `GET /workspaces/:workspaceId/executions/:executionId`
 * continues to work completely unchanged and returns the exact same
 * record `GET .../human-tasks/:executionId` does.
 */

const SUPPORTED_DECISIONS: ReadonlySet<string> = new Set<HumanTaskDecision>(['approve', 'reject']);
const MAX_DECISION_DATA_BYTES = 8 * 1024; // generous for a small structured decision payload; bounds it well below the request body's own 64MB cap without inventing a new configurable limit for this milestone.

function toWireRecord(record: ExecutionRecord): ExecutionRecord {
  return record;
}

function isHumanTask(record: ExecutionRecord): boolean {
  return record.humanTask !== undefined;
}

interface ResolveBody {
  readonly decision?: unknown;
  readonly data?: unknown;
}

function parseResolveBody(body: ResolveBody): { readonly decision: HumanTaskDecision; readonly data?: Readonly<Record<string, unknown>> } {
  if (typeof body.decision !== 'string' || !SUPPORTED_DECISIONS.has(body.decision)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"decision" must be one of: ${[...SUPPORTED_DECISIONS].join(', ')}`);
  }
  const decision = body.decision as HumanTaskDecision;

  if (body.data === undefined) return { decision };
  // "Do not accept unconstrained data" (brief) — bounded to a plain,
  // non-array, non-null JSON object of modest size. No capability this
  // codebase currently resolves via `ActionEscalationBindingResolver`
  // declares an `inputSchema` to validate against more precisely (see
  // this milestone's audit finding on why) — if a future capability
  // does, this is the one place to add a `validateCapabilityInput` call
  // against it, exactly as `execute-capability.ts` already does for
  // execution input.
  if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"data", if present, must be a plain JSON object');
  }
  const serialized = JSON.stringify(body.data);
  if (serialized.length > MAX_DECISION_DATA_BYTES) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"data" must be at most ${MAX_DECISION_DATA_BYTES} bytes serialized`);
  }
  return { decision, data: body.data as Readonly<Record<string, unknown>> };
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

export function registerHumanTaskRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
): void {
  async function listHumanTasks(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    return json(200, { humanTasks: listed.value.filter(isHumanTask).map(toWireRecord) });
  }

  async function getHumanTask(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');
    const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const found = await store.get(executionId);
    if (!found.ok) throw found.error;
    // "Non-HITL executions cannot be resolved/retrieved as human tasks"
    // — treated as 404 here (not 400), consistent with every other
    // "wrong kind of thing at this id" case elsewhere in this API (e.g.
    // P0.5's capability-not-in-this-compilation check).
    if (!isHumanTask(found.value)) throw new NotFoundError(`human task "${executionId}"`);
    return json(200, toWireRecord(found.value));
  }

  async function resolveHumanTask(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const executionId = req.params['executionId'];
    if (executionId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing execution id');

    const bodyResult = await req.json<ResolveBody>();
    if (!bodyResult.ok) throw bodyResult.error;
    // No "identityId", "capabilityId", "executionClass", or
    // "runtimeDeclaration" field is ever read from this body — the only
    // fields consulted are "decision" and "data". Resolver identity
    // always comes from `req.identity`, never the body (same discipline
    // as every prior milestone's create/approve routes).
    const { decision, data } = parseResolveBody(bodyResult.value);

    // "Verify the resolver has permission to resolve the task" — the
    // narrowest explicit policy this milestone implements, per the
    // brief's own allowance ("if a full RBAC policy store does not yet
    // exist, implement the narrowest explicit policy... and document
    // the limitation"): workspace ownership IS the authorization
    // boundary. `requireOwnedWorkspace` above already enforces this —
    // there is no separate reviewer/approver role distinct from
    // "who owns this workspace" anywhere yet in the P0 series (P0.5's
    // capability approval used the exact same boundary). A real
    // reviewer-role RBAC system is explicitly out of this milestone's
    // scope; this comment documents that gap rather than hiding it.
    const resolver = requirePrincipal(req); // P1.0 M1: the authenticated resolving principal (never body-supplied)

    const store = new FsExecutionStore(workspaceExecutionsStore(workspace, dataConfig));
    const compilationStore = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));

    // The lock + pre-check + `attemptResume` + store-write sequence lives
    // in `executions/resolve-human-task.ts` (extracted in P0.8 so the
    // workflow resume route reuses it verbatim) — see that file's doc comment.
    const outcome = await resolveHumanTaskExecution(store, compilationStore, executionId, decision, data, resolver, permissionManager);

    switch (outcome.kind) {
      case 'not_found':
        throw outcome.error;
      case 'not_a_human_task':
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `execution "${executionId}" was never waiting_for_human — nothing to resolve`);
      case 'already_resolved':
        // A deterministic conflict, carrying the ORIGINAL (unmodified) record — proves the second request never overwrote the first decision.
        return json(409, toWireRecord(outcome.record));
      case 'error':
        throw outcome.error;
      case 'resolved':
        return json(200, toWireRecord(outcome.record));
    }
  }

  router.get('/workspaces/:workspaceId/human-tasks', guarded(listHumanTasks));
  router.get('/workspaces/:workspaceId/human-tasks/:executionId', guarded(getHumanTask));
  router.post('/workspaces/:workspaceId/executions/:executionId/resolve', guarded(resolveHumanTask));
}

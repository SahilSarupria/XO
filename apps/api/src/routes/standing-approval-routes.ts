import { ErrorCode, XoError } from '@xo/errors';
import type { PermissionManager } from '@xo/permissions';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest, type ApiResponse } from '../http/types.js';
import { auditedOwnedWorkspace, newCorrelationId, type AuditService } from '../audit/audit-service.js';
import {
  hasPermission,
  requireOwnedWorkspace,
  requirePermission,
  requirePrincipal,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { workspaceDefinitionsStore } from './pre-execution-routes.js';
import { guarded, revokeBatchApproval, type RunnerDeps } from './generated-run-routes.js';
import { StandingStore } from '../approvals/standing-store.js';
import {
  approveStanding,
  proposeStanding,
  requestStandingChanges,
  revokeStanding,
  standingView,
  startUnderStanding,
} from '../approvals/standing-approval.js';
import { parseItemSourceRef } from '../source-connections/items-from-sources.js';
import { periodKey } from '../approvals/standing-store.js';

/**
 * UW-16 (ADR 0051): standing approvals. A person approves, once, the bounds within which runs may start without a per-batch approval;
 * each run under it still gets its own preview and its own batch approval. The views never carry argument values.
 */
export function registerStandingApprovalRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  permissionManager: PermissionManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const auditCtx = { audit, workspaceStore };
  const deps: RunnerDeps = { workspaceStore, dataConfig, permissionManager, env, audit };
  const store = (workspaceId: string) => new StandingStore(dataConfig.dataRootDir, workspaceId);
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 200)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `${name} must be a string`);
    return v;
  };

  async function propose(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'standing-approval.propose', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'propose a standing approval' });
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const b = body.value;
    const known = new Set([
      'definitionId',
      'certificateId',
      'items',
      'input',
      'limits',
      'mayVary',
      'presignSteps',
      'triggers',
      'expiresInDays',
      'startsAs',
      'note',
    ]);
    const stray = Object.keys(b).filter((k) => !known.has(k));
    if (stray.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${stray.join(', ')}`);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(str(b['definitionId'], 'definitionId'));
    const input = b['input'] ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const refs = (v: unknown, name: string): { step: string; argument: string }[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 200) throw new XoError(ErrorCode.INVALID_ARGUMENT, `${name} must be a list`);
      return v.map((x) => ({
        step: str((x as { step?: unknown })?.step, `${name}.step`),
        argument: str((x as { argument?: unknown })?.argument, `${name}.argument`),
      }));
    };
    const presign = b['presignSteps'];
    if (presign !== undefined && (!Array.isArray(presign) || !presign.every((x) => typeof x === 'string')))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'presignSteps must be a list of step names');
    const view = await proposeStanding(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition,
      certificateId: b['certificateId'],
      ...(b['items'] !== undefined ? { items: parseItemSourceRef(b['items']) } : {}),
      input: input as Record<string, unknown>,
      limits: b['limits'],
      mayVary: refs(b['mayVary'], 'mayVary'),
      ...(presign !== undefined ? { presignSteps: presign as string[] } : {}),
      triggers: b['triggers'] as never,
      ...(b['expiresInDays'] !== undefined ? { expiresInDays: b['expiresInDays'] } : {}),
      ...(typeof b['startsAs'] === 'string' ? { startsAs: b['startsAs'] } : {}),
      ...(b['note'] !== undefined ? { note: b['note'] } : {}),
      correlationId,
    });
    return json(201, view);
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const s = store(workspace.workspaceId);
    const now = new Date();
    const out = [];
    for (const r of await s.list()) {
      const v = standingView(r, s, now);
      const key = periodKey(r.proposal.policy.limits.period, now);
      out.push({
        ...v,
        usage: { period: r.proposal.policy.limits.period, ...(await s.usesIn(r.proposal.policy.standingApprovalId, key)) },
      });
    }
    return json(200, { standingApprovals: out });
  }

  async function get(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const s = store(workspace.workspaceId);
    const id = req.params['id'] ?? '';
    const r = await s.get(id);
    const now = new Date();
    const key = periodKey(r.proposal.policy.limits.period, now);
    return json(200, {
      ...standingView(r, s, now),
      usage: { period: r.proposal.policy.limits.period, ...(await s.usesIn(id, key)) },
      uses: (await s.uses(id)).slice(0, 50).map((u) => ({ runId: u.runId, items: u.items, at: u.at })),
      fallbacks: (await s.fallbacks(id)).slice(0, 50),
    });
  }

  async function approve(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'standing-approval.approve', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'approve a standing approval' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'approve a standing approval');
    const body = await req.json<{ policyDigest?: unknown }>();
    if (!body.ok) throw body.error;
    const id = req.params['id'] ?? '';
    const rec = await store(workspace.workspaceId).get(id);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(rec.proposal.policy.definitionId);
    return json(
      200,
      await approveStanding(deps, {
        workspace,
        actor: requirePrincipal(req),
        auth: req.authentication,
        definition,
        id,
        policyDigest: body.value.policyDigest,
        correlationId,
      }),
    );
  }

  async function requestChanges(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'standing-approval.request-changes', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'ask for changes to a standing approval' });
    const body = await req.json<{ comment?: unknown }>();
    if (!body.ok) throw body.error;
    return json(
      200,
      await requestStandingChanges(deps, {
        workspace,
        actor: requirePrincipal(req),
        id: req.params['id'] ?? '',
        comment: body.value.comment,
        correlationId,
      }),
    );
  }

  async function revoke(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'standing-approval.revoke', correlationId });
    const body = await req.json<{ reason?: unknown }>();
    if (!body.ok) throw body.error;
    const principal = requirePrincipal(req);
    // Revoking only removes authority, so it needs no recent sign-in. A reviewer, the proposer or the approver may do it. A caller who
    // can neither review nor author (a viewer) is refused before anything is looked up, as for every other mutating route.
    const canReview = await hasPermission(req, workspace, 'review');
    if (!canReview) await requirePermission(req, workspace, 'author', dataConfig, { action: 'revoke a standing approval' });
    return json(
      200,
      await revokeStanding(deps, {
        workspace,
        actor: { id: principal.id, kind: principal.kind },
        id: req.params['id'] ?? '',
        reason: body.value.reason,
        canReview,
        correlationId,
        principal,
      }),
    );
  }

  async function startRun(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'standing-approval.use', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'start a run under a standing approval' });
    const body = await req.json<{ input?: unknown }>();
    if (!body.ok) throw body.error;
    const unknown = Object.keys(body.value).filter((k) => k !== 'input');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const input = body.value.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const id = req.params['id'] ?? '';
    const rec = await store(workspace.workspaceId).get(id);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(rec.proposal.policy.definitionId);
    const idem = req.headers['idempotency-key'];
    const started = await startUnderStanding(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition,
      id,
      trigger: 'manual',
      input: input as Record<string, unknown>,
      ...(typeof idem === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(idem) ? { idempotencyKey: idem } : {}),
      correlationId,
    });
    return json(started.status, started.body);
  }

  async function revokeApproval(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.batch', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'revoke a batch approval' });
    const body = await req.json<{ reason?: unknown }>();
    if (!body.ok) throw body.error;
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    return json(
      200,
      await revokeBatchApproval(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        previewId: req.params['previewId'] ?? '',
        reason: body.value.reason,
        correlationId,
      }),
    );
  }

  router.post('/workspaces/:workspaceId/standing-approvals', guarded(propose));
  router.get('/workspaces/:workspaceId/standing-approvals', guarded(list));
  router.get('/workspaces/:workspaceId/standing-approvals/:id', guarded(get));
  router.post('/workspaces/:workspaceId/standing-approvals/:id/approve', guarded(approve));
  router.post('/workspaces/:workspaceId/standing-approvals/:id/request-changes', guarded(requestChanges));
  router.post('/workspaces/:workspaceId/standing-approvals/:id/revoke', guarded(revoke));
  router.post('/workspaces/:workspaceId/standing-approvals/:id/runs', guarded(startRun));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/previews/:previewId/approval/revoke', guarded(revokeApproval));
}

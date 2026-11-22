import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import { readInstanceStop } from '@xo/instance';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { workspaceStateStore } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { readConnectorBindings } from '../pre-execution/connector-bindings.js';
import { workspaceWorkflowEntitiesStore } from '../workflow-entities/entity-store.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { engageStop, readStops, releaseStop, validateStop, type StopRecord } from '../workflow-controls/emergency-stops.js';
import { workspaceDefinitionsStore } from './pre-execution-routes.js';

/**
 * RX-1a (ADR 0048) — the workspace's emergency stops over the API. Reading them is the read role; engaging or releasing one is the
 * manage role with a recent sign-in, and both are audited. The instance-wide stop is shown here but set only by an operator on the
 * machine (`xo instance emergency-stop`), because no workspace role is an instance role.
 */
export function registerEmergencyStopRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };
  const guarded =
    (h: (req: ApiRequest) => Promise<ApiResponse>) =>
    async (req: ApiRequest): Promise<ApiResponse> => {
      try {
        return await h(req);
      } catch (e) {
        return errorToResponse(e);
      }
    };

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'read the emergency stops' });
    const instance = await readInstanceStop(dataConfig.dataRootDir);
    const controls = await new FsControlsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).getControls();
    return json(200, {
      instance: instance ?? null,
      workspacePaused: controls.paused,
      stops: await readStops(dataConfig.dataRootDir, workspace.workspaceId),
    });
  }

  const change = (engage: boolean) =>
    guarded(async (req) => {
      const correlationId = newCorrelationId();
      const action = engage ? 'emergency-stop.engage' : 'emergency-stop.release';
      const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
      await requirePermission(req, workspace, 'manage', dataConfig, {
        action: engage ? 'engage an emergency stop' : 'release an emergency stop',
      });
      await requireRecentAuthentication(req, workspace, dataConfig, engage ? 'engage an emergency stop' : 'release an emergency stop');
      const body = await req.json<Record<string, unknown>>();
      if (!body.ok) throw body.error;
      const b = body.value ?? {};
      const allowed = engage ? ['scope', 'target', 'reason'] : ['scope', 'target'];
      const extra = Object.keys(b).filter((k) => !allowed.includes(k));
      if (extra.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${extra.join(', ')}`);
      const { scope, target } = validateStop(b['scope'], b['target']);
      const actor = requirePrincipal(req);
      const audited = async (type: 'emergency-stop.engaged' | 'emergency-stop.released', found = true) =>
        audit.tryRecord({
          type,
          action,
          actor: actorFromPrincipal(actor),
          correlationId,
          outcome: 'completed',
          target: { kind: 'workspace', id: workspace.workspaceId, workspaceId: workspace.workspaceId },
          metadata: { scope, target, ...(engage ? {} : { wasEngaged: found }) },
        });
      if (!engage) {
        const found = await releaseStop(dataConfig.dataRootDir, workspace.workspaceId, scope, target);
        await audited('emergency-stop.released', found);
        return json(200, { released: found, stops: await readStops(dataConfig.dataRootDir, workspace.workspaceId) });
      }
      if (b['reason'] !== undefined && (typeof b['reason'] !== 'string' || b['reason'].length > 500))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason must be text of at most 500 characters');
      // The target must exist: a stop on a misspelt name would look engaged and hold nothing.
      let definitionIds: string[] | undefined;
      if (scope === 'workflow' && target.startsWith('wfl_')) {
        const entity = await workspaceWorkflowEntitiesStore(dataConfig.dataRootDir, workspace.workspaceId).get(target);
        if (entity === undefined) throw new NotFoundError(`workflow "${target}"`);
        definitionIds = [...new Set(entity.versions.map((v) => v.definition.definitionId))];
      } else if (scope === 'workflow') {
        await workspaceDefinitionsStore(workspace, dataConfig).get(target);
      } else {
        const connector = target.split('.')[0]!;
        const bound = (await readConnectorBindings(workspace, dataConfig)).bindings;
        if (!bound.some((x) => x.connector === connector))
          throw new NotFoundError(
            `connector "${connector}" bound in this workspace (bound: ${[...new Set(bound.map((x) => x.connector))].join(', ') || 'none'})`,
          );
        if (scope === 'capability' && !bound.some((x) => x.connector === connector && x.operation === target.slice(connector.length + 1)))
          throw new NotFoundError(`operation "${target}" bound in this workspace`);
      }
      const reason = typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? b['reason'].trim() : undefined;
      const stop: StopRecord = {
        scope,
        target,
        ...(definitionIds !== undefined ? { definitionIds } : {}),
        by: actor.id,
        at: new Date().toISOString(),
        ...(reason !== undefined ? { reason } : {}),
      };
      const stops = await engageStop(dataConfig.dataRootDir, workspace.workspaceId, stop);
      await audited('emergency-stop.engaged');
      return json(201, { stop, stops });
    });

  router.get('/workspaces/:workspaceId/emergency-stops', guarded(list));
  router.post('/workspaces/:workspaceId/emergency-stops', change(true));
  router.post('/workspaces/:workspaceId/emergency-stops/release', change(false));
}

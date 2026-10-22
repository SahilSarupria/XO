import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  workspaceAuditStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsAuditLog } from '../audit/fs-audit-log.js';
import type { AuditEntry } from '../audit/audit-entry.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import type { WorkspaceSettings } from '../settings/workspace-settings.js';

/**
 * In-app notifications, derived from the audit log and filtered by the workspace's notification settings. There is no
 * second store of "notifications": an entry exists iff the audit log has the underlying event, so the two can never
 * disagree. Only a per-identity read marker is stored.
 */

export type NotificationKind = 'escalation' | 'run_failure' | 'workflow_complete';

export interface NotificationWire {
  readonly seq: number;
  readonly at: string;
  readonly kind: NotificationKind;
  readonly event: string;
  readonly target?: { readonly kind: string; readonly id: string; readonly label?: string };
  readonly actorIdentityId: string;
  readonly read: boolean;
}

const RUN_EVENTS: ReadonlySet<string> = new Set(['execution.created', 'workflow.started', 'compilation.started', 'workflow.resumed']);

export function classify(entry: AuditEntry, settings: WorkspaceSettings): NotificationKind | undefined {
  if (entry.result === 'escalated' && settings.notifications.onEscalation) return 'escalation';
  if (entry.result === 'failed' && RUN_EVENTS.has(entry.event) && settings.notifications.onRunFailure) return 'run_failure';
  if ((entry.event === 'workflow.started' || entry.event === 'workflow.resumed') && entry.detail?.['status'] === 'succeeded' && settings.notifications.onWorkflowComplete) {
    return 'workflow_complete';
  }
  return undefined;
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

const readKey = (identityId: string) => `notification-read/${encodeURIComponent(identityId)}.json`;

export function registerNotificationRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  async function readMarker(workspace: Parameters<typeof workspaceStateStore>[0], identityId: string): Promise<number> {
    const raw = await workspaceStateStore(workspace, dataConfig).get(readKey(identityId));
    if (!raw.ok) return 0;
    try {
      const v = (JSON.parse(new TextDecoder().decode(raw.value)) as { throughSeq?: unknown }).throughSeq;
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const identityId = callerIdentityId(req);
    const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
    const throughSeq = await readMarker(workspace, identityId);
    const limitRaw = req.query.get('limit');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"limit" must be an integer from 1 to 200');

    const log = new FsAuditLog(workspaceAuditStore(workspace, dataConfig), workspace.workspaceId);
    const page = await log.list({ limit: 500 });
    const notifications: NotificationWire[] = [];
    for (const entry of page.entries) {
      const kind = classify(entry, settings);
      if (kind === undefined) continue;
      notifications.push({
        seq: entry.seq,
        at: entry.at,
        kind,
        event: entry.event,
        ...(entry.target !== undefined ? { target: entry.target } : {}),
        actorIdentityId: entry.actor.identityId,
        read: entry.seq <= throughSeq,
      });
    }
    return json(200, {
      notifications: notifications.slice(0, limit),
      unread: notifications.filter((n) => !n.read).length,
      readThroughSeq: throughSeq,
      delivery: 'in_app',
    });
  }

  async function markRead(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const identityId = callerIdentityId(req);
    const bodyResult = await req.json<{ throughSeq?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const throughSeq = bodyResult.value?.throughSeq;
    if (typeof throughSeq !== 'number' || !Number.isInteger(throughSeq) || throughSeq < 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"throughSeq" must be a non-negative integer');
    }
    const head = await new FsAuditLog(workspaceAuditStore(workspace, dataConfig), workspace.workspaceId).head();
    const bounded = Math.min(throughSeq, head.seq);
    const current = await readMarker(workspace, identityId);
    const next = Math.max(current, bounded); // a read marker only moves forward
    const put = await workspaceStateStore(workspace, dataConfig).put(readKey(identityId), JSON.stringify({ throughSeq: next }), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
    return json(200, { readThroughSeq: next });
  }

  router.get('/workspaces/:workspaceId/notifications', guarded(list));
  router.post('/workspaces/:workspaceId/notifications/read', guarded(markRead));
}

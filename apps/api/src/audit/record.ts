import { roleOf, type WorkspaceRecord } from '../workspace/workspace.js';
import { workspaceAuditStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { ApiRequest } from '../http/types.js';
import { FsAuditLog } from './fs-audit-log.js';
import type { AuditActor, AuditEventInput } from './audit-entry.js';

/** Who is acting, as the audit log records them: the authenticated identity plus the role it holds in this workspace. Never read from a request body. */
export function actorFor(req: ApiRequest, workspace: WorkspaceRecord): AuditActor {
  const identityId = req.identity?.identityId ?? 'unauthenticated';
  const role = roleOf(workspace, identityId);
  const member = workspace.members?.find((m) => m.identityId === identityId);
  return {
    identityId,
    kind: req.principal?.kind === 'human' ? 'user' : 'service',
    ...(role !== undefined ? { role } : {}),
    ...(member?.displayName !== undefined ? { displayName: member.displayName } : {}),
  };
}

/**
 * Append one event to the workspace audit log on behalf of the request's caller.
 *
 * Best-effort by design: a failure to write the audit entry is reported on stderr and does NOT undo or fail the action
 * that was already performed (the actions are persisted by their own stores first). A deployment that must refuse
 * un-audited actions should treat the stderr line as a page and check `GET /workspaces/:id/audit/verify`.
 */
export async function recordAudit(
  req: ApiRequest,
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  input: Omit<AuditEventInput, 'actor'> & { readonly actor?: AuditActor },
): Promise<void> {
  try {
    const log = new FsAuditLog(workspaceAuditStore(workspace, dataConfig), workspace.workspaceId);
    await log.append({ ...input, actor: input.actor ?? actorFor(req, workspace) });
  } catch (cause) {
    process.stderr.write(
      `[xo-api] audit write failed for workspace ${workspace.workspaceId} (${input.event}): ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
}

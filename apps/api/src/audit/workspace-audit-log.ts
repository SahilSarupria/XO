import type { WorkspaceRecord } from '../workspace/workspace.js';
import { workspaceAuditStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { FsAuditLog } from './fs-audit-log.js';

/** UW-1 — the one way to open a workspace's audit log, so every writer and reader shares the instance's anchoring configuration. */
export function openWorkspaceAuditLog(workspace: WorkspaceRecord, config: WorkspaceDataConfig, now?: () => Date): FsAuditLog {
  return new FsAuditLog(workspaceAuditStore(workspace, config), workspace.workspaceId, now, config.auditAnchor);
}

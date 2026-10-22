import { ErrorCode, XoError } from '@xo/errors';
import { roleOf, type WorkspaceRecord, type WorkspaceRole } from './workspace.js';

/**
 * Workspace-level authorization. Deliberately small: five permissions, four roles, one table.
 *
 *   read     see anything in the workspace
 *   author   upload sources, compile, start runs, edit workflow drafts, install XOs, chat
 *   publish  publish an XO to the workspace registry (record benchmarks / licenses)
 *   review   approve capabilities, resolve human tasks / info requests, resume workflow runs
 *   audit    read the audit log and its integrity check
 *   manage   members, settings
 *
 * The workspace owner is always `admin`. This is a *workspace* policy — it is independent of, and runs after,
 * `@xo/permissions`' capability-level runtime policy (which still decides what a capability may do once executing).
 */
export type WorkspacePermission = 'read' | 'author' | 'publish' | 'review' | 'audit' | 'manage';

const GRANTS: Readonly<Record<WorkspaceRole, ReadonlySet<WorkspacePermission>>> = {
  admin: new Set<WorkspacePermission>(['read', 'author', 'publish', 'review', 'audit', 'manage']),
  publisher: new Set<WorkspacePermission>(['read', 'author', 'publish']),
  reviewer: new Set<WorkspacePermission>(['read', 'review', 'audit']),
  viewer: new Set<WorkspacePermission>(['read']),
};

export function roleAllows(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return GRANTS[role].has(permission);
}

export function permissionsOf(role: WorkspaceRole): readonly WorkspacePermission[] {
  return [...GRANTS[role]];
}

/** A caller that reached a workspace but may not do this: 403 (the caller already knows the workspace exists). */
export class WorkspacePermissionDeniedError extends XoError {
  constructor(
    readonly permission: WorkspacePermission,
    readonly role: WorkspaceRole,
    readonly workspaceId: string,
  ) {
    super(ErrorCode.RUNTIME_PERMISSION_DENIED, `role "${role}" does not have the "${permission}" permission in this workspace`, {
      context: { permission, role, workspaceId },
    });
  }
}

export function assertPermission(record: WorkspaceRecord, identityId: string, permission: WorkspacePermission): WorkspaceRole {
  const role = roleOf(record, identityId);
  if (role === undefined) {
    // Unreachable through the routes (membership is checked first and yields 404), kept fail-closed.
    throw new XoError(ErrorCode.UNKNOWN, 'internal error: permission check for an identity with no workspace role');
  }
  if (!roleAllows(role, permission)) throw new WorkspacePermissionDeniedError(permission, role, record.workspaceId);
  return role;
}

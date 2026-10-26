import type { WorkspacePermission } from '../platform/wire-studio';
import type { WorkspaceRole } from '../platform/wire';

/**
 * What a role is OFFERED in the UI. This mirrors the platform's table (apps/api/src/workspace/permissions.ts) so Studio
 * can disable a control and say why instead of letting a person click into a refusal.
 *
 * It is a presentation hint and NEVER authorization: hiding or disabling a control protects nothing. Every request still
 * goes to the API, which enforces the real role and answers 403 (shown as a permission-denied notice) if Studio's idea
 * of the table is out of date. A caller whose role Studio does not know (an older platform) is offered everything and
 * left to the API.
 */
const GRANTS: Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>> = {
  admin: ['read', 'author', 'publish', 'review', 'audit', 'manage'],
  publisher: ['read', 'author', 'publish'],
  reviewer: ['read', 'review', 'audit'],
  viewer: ['read'],
};

export function can(role: WorkspaceRole | undefined, permission: WorkspacePermission): boolean {
  return role === undefined ? true : GRANTS[role].includes(permission);
}

const ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = {
  admin: 'Admin',
  publisher: 'Publisher',
  reviewer: 'Reviewer',
  viewer: 'Viewer',
};
export const roleLabel = (r: WorkspaceRole): string => ROLE_LABEL[r];

/** The one-line reason shown beside a disabled control. */
export function whyNot(role: WorkspaceRole | undefined, permission: WorkspacePermission, doing: string): string {
  return `${role !== undefined ? roleLabel(role) : 'Your role'} access does not include ${doing}. Ask a workspace admin if you need it.`;
}

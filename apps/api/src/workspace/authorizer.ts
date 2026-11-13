import {
  DomainCeilingPolicy,
  PermissionManager,
  Permissions,
  RuleBasedPolicy,
  toPrincipalSnapshot,
  type PermissionId,
  type PermissionPolicy,
  type PolicyRule,
  type Principal,
} from '@xo/permissions';
import { PackageId } from '@xo/types';
import { permissionsOf, type WorkspacePermission } from './permissions.js';
import { WORKSPACE_ROLES, type WorkspaceRole } from './workspace.js';

/**
 * UW-1 (ADR 0010): the single authorization point for workspace operations.
 *
 * Every workspace route used to consult the role table directly (`assertPermission`), while procedures, workflow steps, the scheduler
 * and audit access asked `PermissionManager`. Now there is one decision path: `requirePermission` asks the instance's one
 * `PermissionManager`, whose policy is a {@link DomainCeilingPolicy}:
 *
 *  - the `workspace` domain is capped by the role table, expressed as policy rules (one ALLOW per role × permission it grants);
 *  - the operator's policy (`ServerDeps.permissionPolicy`) can narrow that ceiling with an explicit DENY, never widen it;
 *  - every other domain (procedures, effects, capabilities, audit) is decided by the operator policy exactly as before.
 *
 * The role is SERVER-DERIVED: it is resolved from the workspace's own membership records and passed as `context.role`; nothing a
 * client sends is consulted. The six workspace permission ids mirror the role table exactly, so no answer changed (proved by the
 * 4 × 6 equivalence matrix in `single-authorization-point.test.ts`).
 */

export const WORKSPACE_PERMISSION_IDS: Readonly<Record<WorkspacePermission, PermissionId>> = Object.freeze({
  read: Permissions.workspace.read,
  author: Permissions.workspace.author,
  publish: Permissions.workspace.publish,
  review: Permissions.workspace.review,
  audit: Permissions.workspace.audit,
  manage: Permissions.workspace.manage,
});

/** The requester recorded on workspace checks (the API itself, not a package). */
export const WORKSPACE_REQUESTER = Object.freeze({ packageId: PackageId('xo.api'), capabilityId: 'workspace-access' });

/** The role table as policy rules: the ceiling for the `workspace` domain. */
export function workspaceRoleRules(): readonly PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const role of WORKSPACE_ROLES) {
    for (const permission of permissionsOf(role)) {
      rules.push({
        id: `workspace-role.${role}.${permission}`,
        effect: 'ALLOW',
        match: { permission: WORKSPACE_PERMISSION_IDS[permission], role },
      });
    }
  }
  return rules;
}

/** The instance's one authorization policy: workspace roles as a ceiling over `operator` (default: deny everything else). */
export function createAuthorizationPolicy(operator?: PermissionPolicy): PermissionPolicy {
  return new DomainCeilingPolicy({
    domain: 'workspace',
    ceiling: new RuleBasedPolicy(workspaceRoleRules()),
    inner: operator ?? new RuleBasedPolicy([]),
  });
}

let fallback: PermissionManager | undefined;

/**
 * The manager to use when a request carries none. `buildRouter` always attaches the instance's manager; this exists only for route
 * tests that register handlers without the full server. It applies the role ceiling with no operator policy, which is exactly the
 * pre-UW-1 behaviour, so it can never be more permissive than the configured server.
 */
export function fallbackWorkspaceManager(): PermissionManager {
  fallback ??= new PermissionManager({ policy: createAuthorizationPolicy() });
  return fallback;
}

/**
 * True only on an explicit `allow` decision. `prompt`, `deny`, a malformed request and any exception are all `false` (fail closed).
 */
export async function isWorkspaceAllowed(
  manager: PermissionManager,
  input: {
    readonly principal: Principal;
    readonly role: WorkspaceRole;
    readonly workspaceId: string;
    readonly permission: WorkspacePermission;
  },
): Promise<boolean> {
  try {
    const decision = await manager.check({
      permission: WORKSPACE_PERMISSION_IDS[input.permission],
      requester: WORKSPACE_REQUESTER,
      principal: toPrincipalSnapshot(input.principal),
      context: { role: input.role, workspaceId: input.workspaceId },
    });
    return decision.effect === 'allow';
  } catch {
    return false;
  }
}

import {
  resolveDeclaredPermissionIds,
  type AuthenticatedPrincipal,
  type PermissionDeclaration,
  type PermissionManager,
} from '@xo/permissions';
import { XoirNodeId, type XoirGraph } from '@xo/xoir';

/**
 * P1.0 M2 — what every protected API execution needs, bundled so no caller
 * can supply one half and forget the other.
 *
 *  - `subject`: the `AuthenticatedPrincipal` minted by API-key authentication
 *    (`req.principal`). NEVER a body field, header or capability id.
 *  - `permissionManager`: the server-side policy decision point, built once
 *    from operator-supplied rules (`ServerDeps.permissionPolicy`, default
 *    deny-all). A client has no input into it.
 */
export interface ExecutionAuthorization {
  readonly subject: AuthenticatedPrincipal;
  readonly permissionManager: PermissionManager;
}

/**
 * The authoritative permission declaration for one capability: the
 * `requiredPermissions` property of the capability node in the PERSISTED
 * compiled graph. `[]` = explicit permission-free; absent / not an array /
 * invalid id => `unresolved` (denied). The compiler writes this property on
 * every capability node; a graph that lacks it is not trusted to be
 * permission-free.
 */
export function declaredPermissionsForNode(graph: XoirGraph, capabilityId: string): PermissionDeclaration {
  const node = graph.getNode(XoirNodeId(capabilityId));
  if (!node.ok) return resolveDeclaredPermissionIds(undefined, `capability node "${capabilityId}" (${node.error.message})`);
  const properties = node.value.properties as Readonly<Record<string, unknown>> | undefined;
  return resolveDeclaredPermissionIds(properties?.['requiredPermissions'], `capability node "${capabilityId}" requiredPermissions`);
}

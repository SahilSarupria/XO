import type { PackageId } from '@xo/types';
import type { PermissionId } from './permission-id.js';
import type { PermissionScope } from './scope.js';
import type { Principal } from './principal.js';

/** Which package (and, optionally, which of its capabilities) is asking. */
export interface PermissionRequester {
  readonly packageId: PackageId;
  readonly capabilityId?: string;
}

/**
 * Free-form contextual facts a {@link import('./policy.js').PermissionPolicy}
 * rule may match on (e.g. `environment: "production"`) beyond the request's
 * own permission/scope/requester. Deliberately an open record — Runtime,
 * Sandbox, Studio, etc. each know things about "the moment of the request"
 * that this package can't anticipate; `@xo/permissions` only needs to be
 * able to pass them through to policy evaluation, not understand them.
 */
export interface PermissionContext {
  readonly environment?: string;
  readonly [key: string]: unknown;
}

/**
 * Everything a {@link import('./policy.js').PermissionPolicy} needs to
 * make a deterministic decision (§6). `scope` is optional — an absent
 * scope is treated as a request for the permission's broadest applicable
 * meaning and only ever satisfied by a `global`-scoped grant/rule (see
 * `scopeContains` in `scope.ts`), never implicitly narrowed or widened.
 */
export interface PermissionRequest {
  readonly permission: PermissionId;
  readonly scope?: PermissionScope;
  readonly reason?: string;
  readonly requester: PermissionRequester;
  /**
   * P1.0 M2 — the authenticated initiator on whose behalf `requester` is
   * acting, as a plain attribution snapshot. DISTINCT from `requester`
   * (which package/capability is asking). It is set only by
   * `authorizeCapabilityExecution`, which derives it from a verified
   * `AuthenticatedPrincipal`; a policy rule that names a principal never
   * matches a request that has none (fail closed). Absent for a
   * `TrustedExecutionContext` (e.g. the local CLI operator), which is not a
   * principal.
   */
  readonly principal?: Principal;
  readonly context?: PermissionContext;
}

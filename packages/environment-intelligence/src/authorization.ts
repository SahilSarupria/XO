import type { PermissionScope, Principal } from '@xo/permissions';
import type { ConnectorOperation } from './connector.js';
import type { ConnectorId } from './ids.js';

/**
 * Observation is not authorization (principle 3). Every operation that
 * touches a source asks this port first, and nothing is read until it
 * answers `allow`.
 *
 * The authoritative implementation of this port is the platform's
 * `@xo/permissions` `PermissionManager` (rules + grants + revocation), reached
 * through `PermissionManagerAuthorization`. Its requester model is
 * package/capability-shaped, not connector-shaped; the adapter forwards the
 * authenticated principal as `PermissionRequest.principal` (C0.2), so
 * principal-scoped policy rules apply. This package does not evaluate policy;
 * the enforcement point (`authorization-gate.ts`) adds the M2.1 preconditions: an
 * authenticated principal, an unambiguous scope, a decision minted by a
 * trusted constructor, bound to THIS request, spent once, and whose granted
 * scope contains the requested scope.
 *
 * `permission` uses the platform's `domain.action` vocabulary
 * (`filesystem.list`, `filesystem.read`) and `scope` reuses the platform's
 * own `PermissionScope` type, so adopting the real gate is a binding, not
 * a redesign.
 */
export interface AuthorizationRequest {
  readonly connectorId: ConnectorId;
  /** A connector operation, or `declare_sources` for registering administrator-declared systems (see `registerDeclaredSources`). */
  readonly operation: ConnectorOperation | 'declare_sources' | 'revoke_evidence' | 'purge_evidence';
  readonly permission: string;
  readonly scope: PermissionScope;
  /** The authenticated caller. Required at runtime by the enforcement point; optional in the type only so a missing/plain one is rejected, not mistyped. */
  readonly principal?: Principal;
  readonly reason: string;
}

/**
 * Who stands behind a decision. This is DERIVED by the enforcement point from
 * how the decision object was minted (see `trusted-decision.ts`); it is never
 * a field a port can set. A decision object that was not minted by a trusted
 * constructor has authority `none`, whatever its shape claims.
 */
export type AuthorityKind =
  /** No authority was consulted, or the decision was not minted by a trusted constructor. Never accompanies an `allow`. */
  | 'none'
  /** Minted by the platform authorization boundary (`PermissionManagerAuthorization`) from a real `PermissionManager` decision. */
  | 'platform'
  /** An explicit local operator allow-list, with NO platform verification. Development/demo only. */
  | 'development_unverified';

/**
 * What a port answers. Deliberately has NO authority field: an `allow` is
 * honoured only if the exact object was minted by a trusted constructor
 * (`mintDevelopmentDecision`, or the platform adapter), which the
 * enforcement point checks by identity. Anything else - a plain object, a
 * structural copy, a JSON round-trip - is treated as no authority and fails
 * closed. `prompt` means "a human/approval step is still required" and is
 * treated as NOT authorized.
 */
export interface AuthorizationDecision {
  readonly effect: 'allow' | 'deny' | 'prompt';
  readonly reason: string;
}

export interface AuthorizationPort {
  decide(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

/**
 * Fail-closed default. Used whenever no authorization port is wired in:
 * every request answers `prompt` with no authority, so discovery reports
 * `authorization_required` and reads nothing.
 */
export class FailClosedAuthorization implements AuthorizationPort {
  async decide(): Promise<AuthorizationDecision> {
    return { effect: 'prompt', reason: 'no authorization gate is configured; nothing is authorized by default' };
  }
}

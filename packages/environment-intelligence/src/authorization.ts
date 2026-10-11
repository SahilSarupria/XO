import type { PermissionScope, Principal } from '@xo/permissions';
import type { ConnectorOperation } from './connector.js';
import type { ConnectorId } from './ids.js';

/**
 * Observation is not authorization (principle 3). Every operation that
 * touches a source asks this port first, and nothing is read until it
 * answers `allow`.
 *
 * DEPENDENCY ON P1.0 (Enterprise Trust, authorization gate milestone):
 * the authoritative implementation of this port is the platform's
 * `@xo/permissions` `PermissionManager` + policy + audit, wired by P1.0.
 * That gate does not exist for this use yet (its requester model is
 * package/capability-shaped, not connector-shaped). This package therefore
 * ONLY defines the port and the vocabulary; it does not evaluate policy.
 *
 * `permission` uses the platform's `domain.action` vocabulary
 * (`filesystem.list`, `filesystem.read`) and `scope` reuses the platform's
 * own `PermissionScope` type, so adopting the real gate is a binding, not
 * a redesign.
 */
export interface AuthorizationRequest {
  readonly connectorId: ConnectorId;
  /** A connector operation, or `declare_sources` for registering administrator-declared systems (see `registerDeclaredSources`). */
  readonly operation: ConnectorOperation | 'declare_sources';
  readonly permission: string;
  readonly scope: PermissionScope;
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

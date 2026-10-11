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
  readonly operation: ConnectorOperation;
  readonly permission: string;
  readonly scope: PermissionScope;
  readonly principal?: Principal;
  readonly reason: string;
}

/** Who stands behind a decision. Persisted into every piece of evidence's provenance. */
export type AuthorityKind =
  /** No authority was consulted (e.g. fail-closed default). Never accompanies an `allow`. */
  | 'none'
  /** Produced by the platform's authoritative authorization gate. */
  | 'platform'
  /** An explicit local operator allow-list, with NO platform verification. Development/demo only. */
  | 'development_unverified';

export interface AuthorizationDecision {
  /** `prompt` means "a human/approval step is still required" and is treated as NOT authorized. */
  readonly effect: 'allow' | 'deny' | 'prompt';
  readonly authority: AuthorityKind;
  readonly reason: string;
}

export interface AuthorizationPort {
  decide(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

/**
 * Fail-closed default. Used whenever no authorization port is wired in:
 * every request answers `prompt`, so discovery reports
 * `authorization_required` and reads nothing.
 */
export class FailClosedAuthorization implements AuthorizationPort {
  async decide(): Promise<AuthorizationDecision> {
    return { effect: 'prompt', authority: 'none', reason: 'no authorization gate is configured; nothing is authorized by default' };
  }
}

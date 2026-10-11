import { PermissionManager, isAuthenticatedPrincipal, isPermissionScope, parsePermissionId, scopeContains } from '@xo/permissions';
import { PackageId } from '@xo/types';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { mintPlatformDecision } from './trusted-decision.js';

/**
 * The requester LABEL this package presents to `PermissionManager`. It is a
 * package-id label, NOT an identity: on `main`, policy rules and stored grants
 * match on the requester `packageId`, so any grant to this label applies to
 * every caller that reaches this adapter. That is why the adapter ALSO
 * requires an `AuthenticatedPrincipal` (a precondition, and recorded in
 * provenance) - but on `main` policy cannot yet match on the principal, so who
 * the caller is cannot restrict what the label may do. Binding principal to
 * requester is the open connector-shaped-requester contract (P1.0).
 */
export const ENVIRONMENT_INTELLIGENCE_REQUESTER = PackageId('xo.environment-intelligence');

/**
 * The platform authorization boundary: the only producer of `platform`
 * authority. It asks a REAL `PermissionManager` (rules + grants + the
 * manager's own audit sink) and mints a trusted decision from the answer.
 *
 * Fails closed, returning a denial, when: the caller is not an
 * `AuthenticatedPrincipal` (minted by `establishAuthenticatedPrincipal`;
 * a structurally identical plain object is NOT authenticated); the permission
 * id or scope is malformed; the manager answers anything but `allow`
 * (`prompt` is a denial - this adapter never prompts); or an `allow` carries a
 * granted scope that does not contain the requested scope. A throwing manager
 * propagates to the enforcement point, which turns it into a generic internal
 * error without leaking the message.
 *
 * Construction requires an actual `PermissionManager` instance so a
 * duck-typed stand-in cannot be wired in by accident. A subclass can still be,
 * which is the same in-process limitation as the principal marker.
 *
 * Auditing: decisions are recorded by the manager's own `PermissionAuditSink`
 * (package-keyed, synchronous, no principal). This adapter adds NO audit
 * mechanism; durable, principal-aware audit is the unmade P1.0 M4 decision.
 */
export class PermissionManagerAuthorization implements AuthorizationPort {
  private readonly manager: PermissionManager;

  constructor(manager: PermissionManager) {
    if (!(manager instanceof PermissionManager)) {
      throw new TypeError('PermissionManagerAuthorization requires a PermissionManager instance');
    }
    this.manager = manager;
  }

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const deny = (reason: string): AuthorizationDecision => mintPlatformDecision('deny', reason);

    if (!isAuthenticatedPrincipal(request.principal)) return deny('an authenticated principal is required');
    const permission = parsePermissionId(request.permission);
    if (!permission.ok) return deny('the requested permission id is not valid');
    if (!isPermissionScope(request.scope)) return deny('the requested scope is not valid');

    const decision = await this.manager.check({
      permission: permission.value.id,
      scope: request.scope,
      requester: { packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, capabilityId: request.connectorId },
      reason: request.reason,
    });

    if (decision.effect === 'allow') {
      if (decision.grantedScope === undefined || !scopeContains(decision.grantedScope, request.scope)) {
        return deny('the granted scope does not contain the requested scope');
      }
      return mintPlatformDecision('allow', decision.reason);
    }
    if (decision.effect === 'deny') return mintPlatformDecision('deny', decision.reason);
    return mintPlatformDecision('prompt', decision.reason);
  }
}

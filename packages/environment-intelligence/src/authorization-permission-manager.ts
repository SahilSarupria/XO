import {
  PermissionManager,
  isAuthenticatedPrincipal,
  isPermissionScope,
  parsePermissionId,
  scopeContains,
  toPrincipalSnapshot,
} from '@xo/permissions';
import { PackageId } from '@xo/types';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { mintPlatformDecision, type DecisionBinding } from './trusted-decision.js';

/** Policy ids are recorded in provenance and audit, so only a short identifier is carried; anything else is dropped, never echoed. (The audit layer additionally digests any id that is not in its stricter, slash-free alphabet.) */
const SAFE_POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/**
 * The requester LABEL this package presents to `PermissionManager`. It is a
 * package-id label, NOT an identity: policy rules and stored grants match on
 * the requester `packageId`, so a rule or grant naming only this label applies
 * to every caller that reaches this adapter. Who the caller is travels
 * separately, as `PermissionRequest.principal` (C0.2): the adapter forwards the
 * verified principal so a principal-scoped policy rule (`principalId` /
 * `principalKind`, P1.0 M2) can restrict what the label may do for a given
 * caller. Stored grants are still package-keyed and do not match on the
 * principal (see `PermissionManagerAuthorization`).
 */
export const ENVIRONMENT_INTELLIGENCE_REQUESTER = PackageId('xo.environment-intelligence');

/**
 * The platform authorization boundary: the only producer of `platform`
 * authority. It asks a REAL `PermissionManager` (rules + grants + the
 * manager's own audit sink) and mints a trusted decision from the answer.
 *
 * Principal wiring (C0.2): the `AuthenticatedPrincipal` the enforcement point
 * already verified is reduced to a plain attribution snapshot
 * (`toPrincipalSnapshot`) and set as `PermissionRequest.principal`, exactly as
 * the platform's `authorizeCapabilityExecution` does. The principal is read ONLY
 * from the verified `request.principal`; nothing else on the request (and no
 * `orgId` label) is consulted to choose the identity the policy sees, and no
 * caller-supplied `context` is forwarded. A principal-scoped rule therefore
 * matches only the authenticated principal it names; a request with no
 * authenticated principal never reaches the manager.
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
 * M2.1 binding: every decision this adapter mints is bound to the exact
 * request it answered (principal snapshot, connector, operation, permission,
 * requested scope) and, for an allow, to the scope the manager actually
 * granted. The enforcement point (`requireAuthorization`) re-checks the
 * binding and that the granted scope contains the requested one, and spends the
 * decision, so it cannot be replayed for another request.
 *
 * Auditing: decisions are recorded by the manager's own `PermissionAuditSink`
 * (package-keyed, synchronous, no principal). This adapter adds NO audit
 * mechanism; EI's own principal-aware audit is the M2.2 audit port
 * (`audit.ts`), persisted by P1.0 M4.
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

    const authenticatedPrincipal: unknown = request.principal;
    if (!isAuthenticatedPrincipal(authenticatedPrincipal)) return deny('an authenticated principal is required');
    const principal = toPrincipalSnapshot(authenticatedPrincipal);
    const permission = parsePermissionId(request.permission);
    if (!permission.ok) return deny('the requested permission id is not valid');
    if (!isPermissionScope(request.scope)) return deny('the requested scope is not valid');

    const bind = (extra: Pick<DecisionBinding, 'grantedScope' | 'policyId' | 'lifetime'> = {}): DecisionBinding => ({
      principal,
      connectorId: request.connectorId,
      operation: request.operation,
      permission: request.permission,
      requestedScope: request.scope,
      ...extra,
    });

    const decision = await this.manager.check({
      permission: permission.value.id,
      scope: request.scope,
      requester: { packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, capabilityId: request.connectorId },
      principal,
      reason: request.reason,
    });

    if (decision.effect === 'allow') {
      if (decision.grantedScope === undefined || !scopeContains(decision.grantedScope, request.scope)) {
        return deny('the granted scope does not contain the requested scope');
      }
      return mintPlatformDecision(
        'allow',
        decision.reason,
        bind({
          grantedScope: decision.grantedScope,
          ...(decision.policyId !== undefined && SAFE_POLICY_ID.test(decision.policyId) ? { policyId: decision.policyId } : {}),
          ...(decision.lifetime !== undefined ? { lifetime: decision.lifetime } : {}),
        }),
      );
    }
    if (decision.effect === 'deny') return mintPlatformDecision('deny', decision.reason, bind());
    return mintPlatformDecision('prompt', decision.reason, bind());
  }
}

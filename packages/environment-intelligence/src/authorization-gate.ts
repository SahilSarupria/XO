import { isAbsolute } from 'node:path';
import {
  isAuthenticatedPrincipal,
  isPermissionScope,
  parsePermissionId,
  principalsEqual,
  scopeContains,
  scopeKey,
  toPrincipalSnapshot,
  type PermissionScope,
  type Principal,
} from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuthorityKind, AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import { authorityOf, bindingOf, consumeDecision } from './trusted-decision.js';

/** What the enforcement point learned about an honoured allow. Everything here is derived from trusted sources, never from a port-supplied field. */
export interface TrustedGrant {
  /** The scope that was actually granted, when the decision was minted with one. Always contains the requested scope. */
  readonly grantedScope?: PermissionScope;
  readonly policyId?: string;
  readonly lifetime?: 'once' | 'session' | 'persistent';
}

export interface TrustedAllow {
  readonly decision: AuthorizationDecision;
  /** Derived from how the decision was minted. Never `none`, never copied from a port-supplied field. */
  readonly authority: Exclude<AuthorityKind, 'none'>;
  /** Plain attribution snapshot of the authenticated principal this allow was enforced for. */
  readonly principal: Principal;
  readonly grant: TrustedGrant;
}

/**
 * Identity precondition shared by every protected entry point (M2.1). A caller
 * is authenticated only if its principal is the exact object minted by
 * `establishAuthenticatedPrincipal` in this process (`isAuthenticatedPrincipal`):
 * a plain object, a structural copy, a JSON round-trip, a principal read from a
 * request/header/environment variable, or one found in a discovery result is NOT
 * authenticated. This runs BEFORE any port is consulted and before any inventory
 * or filesystem lookup, so an unauthenticated caller learns nothing.
 */
export function requireAuthenticatedPrincipal(principal: unknown, permission?: string): Result<Principal, DiscoveryError> {
  if (isAuthenticatedPrincipal(principal)) return ok(toPrincipalSnapshot(principal));
  return err(
    discoveryError(DiscoveryErrorCode.UNAUTHENTICATED, 'an authenticated principal is required', {
      ...(permission !== undefined ? { permission } : {}),
      authority: 'none',
    }),
  );
}

const hasNul = (s: string): boolean => s.includes('\u0000');
const hasDotSegment = (s: string): boolean => s.split('/').some((seg) => seg === '..' || seg === '.');

/**
 * A scope EI will ever ask the platform about must be unambiguous: a `path`
 * scope is an absolute, NUL-free, dot-segment-free path; a `resource` scope is a
 * non-empty NUL-free name; `global` (and every kind EI does not use) is refused
 * outright, so a request can never be interpreted as "everything".
 */
function scopeProblem(scope: unknown): string | undefined {
  if (!isPermissionScope(scope)) return 'malformed_scope';
  switch (scope.kind) {
    case 'path':
      return isAbsolute(scope.path) && !hasNul(scope.path) && !hasDotSegment(scope.path) ? undefined : 'ambiguous_path_scope';
    case 'resource':
      return scope.resource.length > 0 && !hasNul(scope.resource) && !hasDotSegment(scope.resource)
        ? undefined
        : 'ambiguous_resource_scope';
    default:
      return 'unsupported_scope_kind';
  }
}

const denied = (request: AuthorizationRequest, authority: AuthorityKind, reason: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.AUTHORIZATION_DENIED, 'authorization was denied', {
    permission: request.permission,
    authority,
    reason,
  });

/**
 * The single enforcement point for every authorization decision in this
 * package. Order is the security property:
 *
 *  1. IDENTITY: the caller must be an `AuthenticatedPrincipal` (M2.1). Fails
 *     with `EI_UNAUTHENTICATED` before the port is consulted.
 *  2. REQUEST SHAPE: a malformed permission id or an ambiguous / global scope
 *     is rejected (`EI_MALFORMED_INPUT` / `EI_SCOPE_VIOLATION`) before the port
 *     is consulted. There is no default-allow and no scope widening.
 *  3. DECISION: an `allow` is honoured only when the exact decision object was
 *     minted by a trusted constructor. Deny, prompt, a forged or cloned `allow`,
 *     a malformed decision and a throwing/unavailable port are all errors.
 *  4. BINDING: a decision minted with a binding must answer THIS request (same
 *     principal, connector, operation, permission and scope), must not have been
 *     presented before, and must carry a granted scope that CONTAINS the
 *     requested scope. A `platform` decision without a binding is refused: the
 *     platform adapter always binds.
 *
 * Public error text and context are fixed strings plus the permission and
 * DERIVED authority and a fixed reason code, so a denial does not depend on, or
 * reveal, what the requested path is.
 */
export async function requireAuthorization(
  port: AuthorizationPort,
  request: AuthorizationRequest,
): Promise<Result<TrustedAllow, DiscoveryError>> {
  const who = requireAuthenticatedPrincipal(request.principal, request.permission);
  if (!who.ok) return who;

  if (typeof request.permission !== 'string' || !parsePermissionId(request.permission).ok) {
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the requested permission id is not valid', { authority: 'none' }));
  }
  const problem = scopeProblem(request.scope);
  if (problem !== undefined) {
    return err(
      discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the requested scope is not acceptable', {
        permission: request.permission,
        authority: 'none',
        reason: problem,
      }),
    );
  }

  let decision: AuthorizationDecision;
  try {
    decision = await port.decide(request);
  } catch (e) {
    return err(internalError(e, 'authorization gate'));
  }
  const authority = authorityOf(decision);
  const isObject = decision !== null && typeof decision === 'object';
  if (isObject && decision.effect === 'allow' && authority !== 'none') {
    const binding = bindingOf(decision);
    if (binding === undefined) {
      // Only the legacy, unbound DEVELOPMENT decision may lack a binding. A platform decision is always bound.
      if (authority === 'platform') return err(denied(request, authority, 'unbound_platform_decision'));
      return ok({ decision, authority, principal: who.value, grant: {} });
    }
    if (!consumeDecision(decision)) return err(denied(request, authority, 'decision_replayed'));
    const sameRequest =
      principalsEqual(binding.principal, who.value) &&
      binding.connectorId === request.connectorId &&
      binding.operation === request.operation &&
      binding.permission === request.permission &&
      scopeKey(binding.requestedScope) === scopeKey(request.scope);
    if (!sameRequest) return err(denied(request, authority, 'decision_binding_mismatch'));
    if (binding.grantedScope === undefined || !scopeContains(binding.grantedScope, request.scope)) {
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the granted scope does not contain the requested scope', {
          permission: request.permission,
          authority,
          reason: 'granted_scope_does_not_contain_request',
        }),
      );
    }
    return ok({
      decision,
      authority,
      principal: who.value,
      grant: {
        grantedScope: binding.grantedScope,
        ...(binding.policyId !== undefined ? { policyId: binding.policyId } : {}),
        ...(binding.lifetime !== undefined ? { lifetime: binding.lifetime } : {}),
      },
    });
  }
  if (isObject && decision.effect === 'deny') {
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_DENIED, 'authorization was denied', { permission: request.permission, authority }),
    );
  }
  return err(
    discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'authorization is required before this source can be read', {
      permission: request.permission,
      authority,
    }),
  );
}

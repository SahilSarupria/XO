import { relative, isAbsolute, resolve, sep } from 'node:path';
import { isAuthenticatedPrincipal, pathScope, toPrincipalSnapshot } from '@xo/permissions';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { mintBoundDevelopmentDecision, mintDevelopmentDecision } from './trusted-decision.js';

/** One explicit local grant: this permission, for paths at or below `path`. */
export interface DevelopmentGrant {
  readonly permission: string;
  readonly path: string;
}

/**
 * DEVELOPMENT / DEMO ONLY — NOT a policy engine and NOT the platform gate.
 *
 * It answers `allow` only when an operator wrote down, in code or CLI
 * arguments, exactly this permission for exactly this path subtree, and it
 * mints every allow through `mintDevelopmentDecision`, so the enforcement
 * point derives `development_unverified` authority from the decision's
 * identity and that stamp travels into evidence provenance and the model.
 * Nothing downstream may treat such evidence as platform-authorized.
 *
 * It exists so the read-only prototype is runnable before P1.0's
 * authorization gate lands; it must be replaced by (not extended into) the
 * `@xo/permissions`-backed port. It deliberately has no wildcards, no
 * roles, no persistence and no escalation.
 *
 * M2.1: even this development port requires an AUTHENTICATED principal (an
 * operator's code-level allow-list is not an identity), and its allow is bound
 * to the request it answered and to the granted subtree, exactly like the
 * platform adapter's, so the same enforcement-point checks apply to it.
 */
export class DevelopmentOperatorAuthorization implements AuthorizationPort {
  private readonly grants: readonly DevelopmentGrant[];

  constructor(grants: readonly DevelopmentGrant[]) {
    this.grants = grants.map((g) => ({ permission: g.permission, path: resolve(g.path) }));
  }

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    if (!isAuthenticatedPrincipal(request.principal)) {
      return mintDevelopmentDecision('deny', 'an authenticated principal is required');
    }
    const principal = toPrincipalSnapshot(request.principal);
    if (request.scope.kind !== 'path') {
      return mintDevelopmentDecision('deny', 'only path-scoped requests can be granted by the development operator allow-list');
    }
    const wanted = request.scope.path;
    if (!isAbsolute(wanted)) {
      return mintDevelopmentDecision('deny', 'requested path scope is not absolute');
    }
    for (const grant of this.grants) {
      if (grant.permission !== request.permission) continue;
      const rel = relative(grant.path, wanted);
      const inside = rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
      if (inside) {
        return mintBoundDevelopmentDecision(
          'allow',
          `operator allow-list grants ${grant.permission} under the declared path (development only, not platform-verified)`,
          {
            principal,
            connectorId: request.connectorId,
            operation: request.operation,
            permission: request.permission,
            requestedScope: request.scope,
            grantedScope: pathScope(grant.path),
          },
        );
      }
    }
    return { effect: 'prompt', reason: `no operator grant covers ${request.permission} for the requested path` };
  }
}

import { relative, isAbsolute, resolve, sep } from 'node:path';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { mintDevelopmentDecision } from './trusted-decision.js';

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
 */
export class DevelopmentOperatorAuthorization implements AuthorizationPort {
  private readonly grants: readonly DevelopmentGrant[];

  constructor(grants: readonly DevelopmentGrant[]) {
    this.grants = grants.map((g) => ({ permission: g.permission, path: resolve(g.path) }));
  }

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
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
        return mintDevelopmentDecision(
          'allow',
          `operator allow-list grants ${grant.permission} under the declared path (development only, not platform-verified)`,
        );
      }
    }
    return { effect: 'prompt', reason: `no operator grant covers ${request.permission} for the requested path` };
  }
}

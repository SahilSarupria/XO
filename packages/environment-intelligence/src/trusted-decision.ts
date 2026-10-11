import type { AuthorityKind, AuthorizationDecision } from './authorization.js';

/**
 * The trusted decision boundary (F2).
 *
 * Authority is never read from a decision's fields. It is looked up by object
 * IDENTITY in a module-private registry that only the constructors below can
 * write to. A decision that is not in the registry has authority `none`, so a
 * port returning `{ effect: 'allow', authority: 'platform' }`, a structural
 * clone of a genuine decision, or a JSON round-trip of one, is not
 * authorization.
 *
 * Who may mint what:
 *  - `mintDevelopmentDecision` is exported publicly. It can only ever produce
 *    `development_unverified` authority, which is never labelled `platform`.
 *  - `mintPlatformDecision` is INTERNAL: it is not re-exported from the
 *    package index, and exactly one module (`authorization-permission-manager.ts`)
 *    imports it, after consulting a real `PermissionManager`. A test pins both facts.
 *
 * Limitation (same as the P1.0 M1 `AuthenticatedPrincipal` marker): this is an
 * in-process guarantee. Code in the same process that imports the internal
 * module path can still mint a platform decision. The trust boundary is the
 * reviewable set of call sites, not a cryptographic proof.
 */
const registry = new WeakMap<object, Exclude<AuthorityKind, 'none'>>();

function mint(kind: Exclude<AuthorityKind, 'none'>, effect: AuthorizationDecision['effect'], reason: string): AuthorizationDecision {
  const decision: AuthorizationDecision = Object.freeze({ effect, reason });
  registry.set(decision, kind);
  return decision;
}

/** The authority a decision carries, by identity. `none` for anything that was not minted by a trusted constructor. */
export function authorityOf(decision: unknown): AuthorityKind {
  if (typeof decision !== 'object' || decision === null) return 'none';
  return registry.get(decision) ?? 'none';
}

/** Development/demo decisions. Always `development_unverified`; never `platform`. */
export function mintDevelopmentDecision(effect: AuthorizationDecision['effect'], reason: string): AuthorizationDecision {
  return mint('development_unverified', effect, reason);
}

/** INTERNAL - do not re-export. Only the `PermissionManager` adapter may call this. */
export function mintPlatformDecision(effect: AuthorizationDecision['effect'], reason: string): AuthorizationDecision {
  return mint('platform', effect, reason);
}

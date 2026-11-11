import type { PermissionScope, Principal } from '@xo/permissions';
import type { AuthorityKind, AuthorizationDecision } from './authorization.js';

/**
 * The trusted decision boundary (F2, extended by M2.1).
 *
 * Authority is never read from a decision's fields. It is looked up by object
 * IDENTITY in a module-private registry that only the constructors below can
 * write to. A decision that is not in the registry has authority `none`, so a
 * port returning `{ effect: 'allow', authority: 'platform' }`, a structural
 * clone of a genuine decision, or a JSON round-trip of one, is not
 * authorization.
 *
 * M2.1 adds a second module-private registry: the BINDING of a decision to the
 * exact request it answered (who asked, which connector/operation/permission,
 * which scope) and, for an allow, the scope that was actually granted. The
 * enforcement point (`authorization-gate.ts`) checks the binding against the
 * request it is enforcing, so a genuine allow for one request cannot be
 * replayed for another (a different principal, operation, permission or
 * scope), and a granted scope that does not contain the requested scope is
 * refused whatever the port said. A bound decision is also SINGLE-USE: the
 * gate consumes it, so presenting the same bound object twice fails closed.
 * Bindings are read from the registry, never from fields on the decision, so
 * they cannot be forged by shape.
 *
 * Who may mint what:
 *  - `mintDevelopmentDecision` is exported publicly. It can only ever produce
 *    `development_unverified` authority, which is never labelled `platform`.
 *    It carries NO binding (legacy, reusable); the binding checks below apply
 *    to decisions minted through the internal bound constructors.
 *  - `mintPlatformDecision` / `mintBoundDevelopmentDecision` are INTERNAL: they
 *    are not re-exported from the package index. `mintPlatformDecision` is
 *    imported by exactly one module (`authorization-permission-manager.ts`),
 *    after consulting a real `PermissionManager`; a test pins both facts.
 *
 * Limitation (same as the P1.0 M1 `AuthenticatedPrincipal` marker): this is an
 * in-process guarantee. Code in the same process that imports the internal
 * module path can still mint a platform decision. The trust boundary is the
 * reviewable set of call sites, not a cryptographic proof.
 */
const registry = new WeakMap<object, Exclude<AuthorityKind, 'none'>>();
const bindings = new WeakMap<object, DecisionBinding>();
const consumed = new WeakSet<object>();
/** C1: decisions the enforcement point actually HONOURED (passed every check for the request it was enforcing). */
const honoured = new WeakSet<object>();

/** What a decision answered. Compared by the gate against the live request; never read from the decision's own fields. */
export interface DecisionBinding {
  /** Plain attribution snapshot of the authenticated principal the decision was made for. */
  readonly principal: Principal;
  readonly connectorId: string;
  readonly operation: string;
  readonly permission: string;
  /** The scope that was asked for. */
  readonly requestedScope: PermissionScope;
  /** The scope that was actually granted (present for an `allow`). The gate re-checks that it contains `requestedScope`. */
  readonly grantedScope?: PermissionScope;
  /** Id of the policy rule that produced the decision, when the platform reports one (a log-safe identifier, not free text). */
  readonly policyId?: string;
  readonly lifetime?: 'once' | 'session' | 'persistent';
}

function mint(
  kind: Exclude<AuthorityKind, 'none'>,
  effect: AuthorizationDecision['effect'],
  reason: string,
  binding?: DecisionBinding,
): AuthorizationDecision {
  const decision: AuthorizationDecision = Object.freeze({ effect, reason });
  registry.set(decision, kind);
  if (binding !== undefined) bindings.set(decision, Object.freeze({ ...binding }));
  return decision;
}

/** The authority a decision carries, by identity. `none` for anything that was not minted by a trusted constructor. */
export function authorityOf(decision: unknown): AuthorityKind {
  if (typeof decision !== 'object' || decision === null) return 'none';
  return registry.get(decision) ?? 'none';
}

/** INTERNAL - the binding recorded when the decision was minted, or `undefined` for an unbound (legacy development) decision. */
export function bindingOf(decision: unknown): DecisionBinding | undefined {
  if (typeof decision !== 'object' || decision === null) return undefined;
  return bindings.get(decision);
}

/** INTERNAL - marks a decision as spent. Returns `false` if it was already spent (a replay). Unbound decisions are never spent. */
export function consumeDecision(decision: object): boolean {
  if (!bindings.has(decision)) return true;
  if (consumed.has(decision)) return false;
  consumed.add(decision);
  return true;
}

/** INTERNAL - the enforcement point records that it honoured this decision. Only `requireAuthorization` calls this. */
export function markHonoured(decision: object): void {
  honoured.add(decision);
}

/** INTERNAL - true only for a decision `requireAuthorization` honoured. Lets the framework verify a connector really spent its permission. */
export function wasHonoured(decision: unknown): boolean {
  return typeof decision === 'object' && decision !== null && honoured.has(decision);
}

/** Development/demo decisions without a binding. Always `development_unverified`; never `platform`. Reusable (legacy). */
export function mintDevelopmentDecision(effect: AuthorizationDecision['effect'], reason: string): AuthorizationDecision {
  return mint('development_unverified', effect, reason);
}

/** INTERNAL - do not re-export. A development decision bound to the request it answered; single-use. */
export function mintBoundDevelopmentDecision(
  effect: AuthorizationDecision['effect'],
  reason: string,
  binding: DecisionBinding,
): AuthorizationDecision {
  return mint('development_unverified', effect, reason, binding);
}

/** INTERNAL - do not re-export. Only the `PermissionManager` adapter may call this. */
export function mintPlatformDecision(
  effect: AuthorizationDecision['effect'],
  reason: string,
  binding?: DecisionBinding,
): AuthorizationDecision {
  return mint('platform', effect, reason, binding);
}

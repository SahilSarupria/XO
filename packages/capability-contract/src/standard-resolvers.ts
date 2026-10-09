import { StructuredComparisonBindingResolver } from './structured-comparison-resolver.js';
import { ActionEscalationBindingResolver } from './action-escalation-resolver.js';
import type { BindingResolver } from './types.js';

/**
 * P0.9B Step 2 — the one canonical `[StructuredComparisonBindingResolver,
 * ActionEscalationBindingResolver]` resolver list, previously declared
 * independently (same two classes, same order, same behavior) in at
 * least five places: `@xo/compiler`'s `capability-lowering.ts` (the
 * documented default for `lowerCapabilitiesToManifest`), `@xo/runtime`'s
 * `candidate-workflow-bridge.ts` (as an unexported
 * `standardBridgeResolvers`), `@xo/workflow-composer`'s `audit.ts` (as
 * two separately-named consts), `@xo/benchmark`'s `observe.ts`, and
 * `apps/api`'s `execute-capability.ts`.
 *
 * The two resolvers partition every `SemanticCapabilityContract`
 * disjointly by construction — `StructuredComparisonBindingResolver`
 * requires `rules.length > 0`; `ActionEscalationBindingResolver`
 * requires `rules.length === 0` (see that resolver's own doc comment) —
 * so this is "the" standard list for `deterministic_rule` +
 * `human_in_the_loop` resolution, not an arbitrary default among many.
 *
 * Both resolver classes are stateless (no constructor parameters, no
 * mutable fields — `resolve()` is a pure function of the contract it is
 * given), so sharing these two singleton instances across every caller
 * is behaviorally identical to each caller constructing its own via
 * `new` — this constant changes nothing about resolver behavior, only
 * where the *list* is declared.
 *
 * A caller with a genuine reason to resolve a narrower or different set
 * (e.g. `apps/cli`'s `deterministic-router.ts`, which intentionally
 * resolves only `[StructuredComparisonBindingResolver]` for the
 * installed-package execution path — see that file's own comment) is
 * unaffected: this constant is an additive convenience for the common
 * case, never a requirement that every resolution use it.
 */
export const STANDARD_BINDING_RESOLVERS: readonly BindingResolver[] = [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()];

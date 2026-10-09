import type { BindingOutcome, BindingResolver, CapabilityBinding, Result_LikeUnknown, SemanticCapabilityContract } from './types.js';

const RESOLVER_NAME = 'action-escalation-resolver';

/**
 * Action Capability Binding v1 — the first generic binding path for a
 * capability the compiler discovered as an operational action or process
 * but for which no deterministic decision procedure exists
 * (`contract.rules` is empty — nothing for
 * `StructuredComparisonBindingResolver` to compile). Resolves such a
 * contract to `implementationClass: 'human_in_the_loop'`: XO recognizes
 * the capability and can route it to a human, but does not claim to be
 * able to autonomously perform it.
 *
 * ---
 * ## Applicability (when this resolver has an opinion at all)
 *
 * This resolver returns `undefined` — "not applicable," per
 * `BindingResolver`'s own contract — unless BOTH:
 *
 *   1. `contract.rules.length === 0` — mirrors
 *      `StructuredComparisonBindingResolver`'s own "nothing to evaluate"
 *      gate exactly, so the two resolvers partition every contract
 *      disjointly. A contract WITH linked rules is always this
 *      resolver's `undefined`, even if those rules fail to compile
 *      deterministically (that stays `unresolved`, owned entirely by the
 *      deterministic-rule resolver's own all-or-nothing policy — this
 *      resolver never second-guesses or overrides that outcome).
 *   2. `contract.actionKnowledgeRefs.length > 0` — the sole generic,
 *      evidence-based signal this resolver acts on (see
 *      `ActionKnowledgeRef`'s doc comment, `types.ts`): a real `REQUIRES`
 *      edge, already materialized by the compiler for an independent
 *      reason, to at least one `concept` node classified as operational
 *      action/process content. A ruleless capability with NO such
 *      linkage is not this resolver's concern either — it stays
 *      `unresolved`, exactly as it did before this resolver existed.
 *      This is the guard that keeps "no rules" from silently becoming
 *      "therefore escalate to a human" for every unrelated,
 *      non-operational capability in the ecosystem (e.g. a bare
 *      information-retrieval capability with no rules and no action
 *      linkage either).
 *
 * Because condition 1 requires an EMPTY rules list and
 * `StructuredComparisonBindingResolver` requires a NON-empty one before
 * it ever reaches a `resolved` outcome, the two resolvers can never both
 * report `resolved` for the same contract — `resolveCapabilityBinding`'s
 * `ambiguous` tie-break path is structurally unreachable between this
 * pair, by construction, not by convention.
 *
 * Deliberately domain-independent: nothing here inspects `category`,
 * `name`, `description`, or any verb/keyword. The exact same resolver
 * fires identically whether the underlying evidence came from an
 * insurance policy, a DevOps runbook, or a CRM playbook — only the
 * `actionKnowledgeRefs` graph-edge evidence is consulted, per this
 * package's evidence-only discipline (see `SemanticCapabilityRule`'s own
 * doc comments for the established convention this follows).
 *
 * ---
 * ## What "resolved" means here — the critical safety boundary
 *
 * A `resolved` outcome from this resolver means: **XO has determined
 * this capability requires a human to perform it, and can route it to
 * one.** It does NOT mean XO can reconcile the invoice, calculate the
 * TDS, or perform whatever the capability's name describes. `evaluate`
 * (below) never attempts the underlying business action — it
 * deterministically produces an inspectable escalation record. A caller
 * that treats a `human_in_the_loop` binding's successful `evaluate` call
 * as "the action was performed" is misusing this binding; the record's
 * own `status: 'escalation_required'` field exists specifically to make
 * that distinction impossible to miss. This preserves, rather than
 * collapses, the brief's required distinction between Bound (this
 * resolver ran and produced a binding), Executable (the binding is
 * registered against a `RuntimeCapabilityRegistry` and passes M1.4
 * confidence/authorization gating), and Successfully Executed (the
 * handler ran and returned its escalation record) — none of the three
 * implies the real-world action happened.
 *
 * `evaluate` is pure and deterministic (same discipline as
 * `StructuredComparisonBindingResolver`'s own evaluator): given the same
 * contract and the same input, it always produces the same record. It
 * never fails on its own account (`ok: true` unconditionally) — there is
 * no business logic here that can go wrong, only a routing decision that
 * always succeeds at being made. Whether the human actually completes
 * the action is outside this resolver's — and this binding's — scope
 * entirely.
 */
export class ActionEscalationBindingResolver implements BindingResolver {
  readonly name = RESOLVER_NAME;

  resolve(contract: SemanticCapabilityContract): BindingOutcome | undefined {
    if (contract.rules.length > 0) return undefined;
    // `?? []`: defends against an embedded contract produced by a
    // pre-Action-Capability-Binding-v1 compiler, where this field simply
    // did not exist yet — the correct forward-compatible reading of an
    // absent, newly-added, non-`required` field is "no evidence," never
    // a crash. See SPECIFICATION.md §6.6's forward-compatibility rule.
    const actionKnowledgeRefs = contract.actionKnowledgeRefs ?? [];
    if (actionKnowledgeRefs.length === 0) return undefined;

    const evaluate = (input: Readonly<Record<string, unknown>>): Result_LikeUnknown => ({
      ok: true,
      value: {
        status: 'escalation_required',
        capabilityId: contract.id,
        capabilityName: contract.name,
        reason: `"${contract.name}" has no known deterministic execution procedure; XO recognized it as an operational action grounded in ${actionKnowledgeRefs.length} linked source node(s), but a human must actually perform it.`,
        actionKnowledgeRefs,
        input,
      },
    });

    const binding: CapabilityBinding = {
      id: `binding_${contract.id}_${RESOLVER_NAME}`,
      contractId: contract.id,
      implementationClass: 'human_in_the_loop',
      resolverName: RESOLVER_NAME,
      description: `No deterministic decision procedure exists for "${contract.name}" — this binding routes execution to a human, grounded in ${actionKnowledgeRefs.length} linked operational-action/process knowledge node(s) (${actionKnowledgeRefs.map((r) => r.sourceNodeId).join(', ')}).`,
      evaluate,
      derivation: {
        actionKnowledgeRefs,
      },
    };
    return { status: 'resolved', binding };
  }
}

import type { PackageId } from '@xo/types';
import type { PermissionDomain } from './domain.js';
import { type PermissionId } from './permission-id.js';
import type { PermissionRequest } from './request.js';
import { type PermissionScope } from './scope.js';
import { type PermissionDecision } from './decision.js';
export type PolicyRuleEffect = 'ALLOW' | 'DENY' | 'PROMPT';
/**
 * The matching dimensions §8 asks for. Every field is optional — an
 * omitted field matches any value on that dimension (a rule with only
 * `permission` set applies regardless of package/capability/environment).
 * `scope` is the one exception: if set, it's matched via
 * {@link scopeContains} against the *request's* scope (so a
 * `path("/workspace")` rule scope matches a request for
 * `path("/workspace/project")`, not the other way around); if omitted,
 * the rule matches any requested scope.
 */
export interface PolicyRuleMatch {
    readonly permission?: PermissionId;
    readonly domain?: PermissionDomain;
    readonly scope?: PermissionScope;
    readonly packageId?: PackageId;
    readonly capabilityId?: string;
    /** Matched against `request.context?.environment`. */
    readonly environment?: string;
}
export interface PolicyRule {
    readonly id: string;
    readonly effect: PolicyRuleEffect;
    readonly match: PolicyRuleMatch;
    /** Manual tiebreaker for two rules with identical computed specificity (see the module doc comment) — higher wins. Rarely needed; specificity + scope narrowness resolve the overwhelming majority of cases on their own. */
    readonly priority?: number;
}
/**
 * §8's policy abstraction. `evaluate` is synchronous and pure — no I/O, no
 * clock reads beyond what the caller threads through `request.context` if
 * it wants that — so "given the same request and policy state, the same
 * decision" (§8, §18's "deterministic evaluation") is true by
 * construction, not by convention.
 */
export interface PermissionPolicy {
    evaluate(request: PermissionRequest): {
        readonly effect: PolicyRuleEffect | 'NO_MATCH';
        readonly reason: string;
        readonly ruleId?: string;
    };
}
/**
 * The reference {@link PermissionPolicy}: a flat, ordered list of
 * {@link PolicyRule}s plus a default effect for when nothing matches.
 *
 * ### Precedence — read this before writing rules
 *
 * §14 asks for a documented, unambiguous precedence model, and gives an
 * example precedence order ("explicit deny > explicit scoped allow >
 * broader allow > default policy > prompt") that it then explicitly
 * invites deviating from "if the existing architecture suggests a safer
 * model". Taken completely literally, that example order is actually
 * self-contradictory: §14's own worked example — a *global* `DENY` on
 * `filesystem.read` coexisting with a *scoped* `ALLOW` on
 * `filesystem.read` at `/workspace/project` that's supposed to win — is
 * impossible under "explicit deny always outranks explicit scoped allow",
 * since the global deny is itself an explicit deny.
 *
 * This engine resolves that the way most real-world ACL/firewall engines
 * do, and the way that actually makes §14's own example work:
 *
 * 1. **Most specific matching rule wins**, full stop — computed from
 *    {@link ruleSpecificity} (exact permission > domain-only; requester
 *    package/capability pinned > not; narrower scope > broader scope),
 *    with `rule.priority` (if set) and finally rule array order as
 *    deterministic tiebreakers.
 * 2. **Among rules tied on specificity, `DENY` wins over `ALLOW`**, which
 *    wins over `PROMPT`. This is the fail-safe piece: two equally-specific
 *    rules should never leave the outcome to array order alone when one
 *    of them is a deny.
 * 3. **If no rule matches at all**, the policy's `defaultEffect` applies
 *    (default `'DENY'` — §18's "default deny").
 *
 * This is *safer* than the literal example order, not looser: a scoped
 * allow can only ever override a *broader* deny (exactly §14's example),
 * never an equally-or-more-specific one — a deny scoped to the exact same
 * permission+scope+package still wins on tiebreak. No rule ever grants
 * more than its own scope says, per `scopeContains`'s no-escalation
 * guarantee, regardless of where it sits in this precedence.
 */
export declare class RuleBasedPolicy implements PermissionPolicy {
    private readonly rules;
    private readonly defaultEffect;
    constructor(rules?: readonly PolicyRule[], defaultEffect?: PolicyRuleEffect);
    /** Returns a new policy with `rule` added — `RuleBasedPolicy` is immutable, matching this repo's copy-on-write convention (see `@xo/runtime`'s `PackageRegistry`). */
    withRule(rule: PolicyRule): RuleBasedPolicy;
    withRules(rules: readonly PolicyRule[]): RuleBasedPolicy;
    evaluate(request: PermissionRequest): {
        readonly effect: PolicyRuleEffect | 'NO_MATCH';
        readonly reason: string;
        readonly ruleId?: string;
    };
    getDefaultEffect(): PolicyRuleEffect;
    getRules(): readonly PolicyRule[];
}
/**
 * Turns a raw policy verdict into a {@link PermissionDecision}. Kept
 * separate from {@link PermissionPolicy} itself so the policy stays a pure
 * `request -> verdict` function while decision construction (timestamps,
 * default-deny wording, `NO_MATCH` handling) lives in one place — used by
 * both `PermissionManager` and anything that wants to preview a policy's
 * verdict without a full manager.
 */
export declare function decisionFromPolicyVerdict(request: PermissionRequest, verdict: {
    readonly effect: PolicyRuleEffect | 'NO_MATCH';
    readonly reason: string;
    readonly ruleId?: string;
}, defaultEffect: PolicyRuleEffect, now: () => Date): PermissionDecision;
//# sourceMappingURL=policy.d.ts.map
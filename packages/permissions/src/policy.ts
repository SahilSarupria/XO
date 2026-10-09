import type { PackageId } from '@xo/types';
import type { PermissionDomain } from './domain.js';
import { permissionDomain, type PermissionId } from './permission-id.js';
import type { PermissionRequest } from './request.js';
import { scopeContains, scopeSpecificity, type PermissionScope } from './scope.js';
import { allowDecision, denyDecision, promptDecision, type PermissionDecision } from './decision.js';

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
  evaluate(request: PermissionRequest): { readonly effect: PolicyRuleEffect | 'NO_MATCH'; readonly reason: string; readonly ruleId?: string };
}

function ruleMatches(rule: PolicyRule, request: PermissionRequest): boolean {
  const m = rule.match;
  if (m.permission !== undefined && m.permission !== request.permission) return false;
  if (m.domain !== undefined && m.domain !== permissionDomain(request.permission)) return false;
  if (m.packageId !== undefined && m.packageId !== request.requester.packageId) return false;
  if (m.capabilityId !== undefined && m.capabilityId !== request.requester.capabilityId) return false;
  if (m.environment !== undefined && m.environment !== request.context?.environment) return false;
  if (m.scope !== undefined && !scopeContains(m.scope, request.scope)) return false;
  return true;
}

/** Higher = more specific = preferred. Mirrors the dimensions in {@link ruleMatches}: every extra dimension a rule pins down narrows what it can match, so it should win over a more general rule when both match. */
function ruleSpecificity(rule: PolicyRule): number {
  const m = rule.match;
  let score = 0;
  if (m.permission !== undefined) score += 20; // exact permission beats domain-only
  else if (m.domain !== undefined) score += 10;
  if (m.packageId !== undefined) score += 8;
  if (m.capabilityId !== undefined) score += 8;
  if (m.environment !== undefined) score += 4;
  if (m.scope !== undefined) score += scopeSpecificity(m.scope);
  return score;
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
export class RuleBasedPolicy implements PermissionPolicy {
  private readonly rules: readonly PolicyRule[];
  private readonly defaultEffect: PolicyRuleEffect;

  constructor(rules: readonly PolicyRule[] = [], defaultEffect: PolicyRuleEffect = 'DENY') {
    this.rules = rules;
    this.defaultEffect = defaultEffect;
  }

  /** Returns a new policy with `rule` added — `RuleBasedPolicy` is immutable, matching this repo's copy-on-write convention (see `@xo/runtime`'s `PackageRegistry`). */
  withRule(rule: PolicyRule): RuleBasedPolicy {
    return new RuleBasedPolicy([...this.rules, rule], this.defaultEffect);
  }

  withRules(rules: readonly PolicyRule[]): RuleBasedPolicy {
    return new RuleBasedPolicy([...this.rules, ...rules], this.defaultEffect);
  }

  evaluate(request: PermissionRequest): { readonly effect: PolicyRuleEffect | 'NO_MATCH'; readonly reason: string; readonly ruleId?: string } {
    const matching = this.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => ruleMatches(rule, request));

    if (matching.length === 0) {
      return { effect: 'NO_MATCH', reason: 'No policy rule matched this request' };
    }

    const effectRank: Record<PolicyRuleEffect, number> = { DENY: 2, ALLOW: 1, PROMPT: 0 };

    matching.sort((a, b) => {
      const specDelta = ruleSpecificity(b.rule) - ruleSpecificity(a.rule);
      if (specDelta !== 0) return specDelta;
      const priorityDelta = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      const effectDelta = effectRank[b.rule.effect] - effectRank[a.rule.effect];
      if (effectDelta !== 0) return effectDelta;
      return a.index - b.index; // stable, deterministic final tiebreak
    });

    const winner = matching[0]!.rule;
    return {
      effect: winner.effect,
      reason: `Policy rule "${winner.id}" matched (${winner.effect})`,
      ruleId: winner.id,
    };
  }

  getDefaultEffect(): PolicyRuleEffect {
    return this.defaultEffect;
  }

  getRules(): readonly PolicyRule[] {
    return this.rules;
  }
}

/**
 * Turns a raw policy verdict into a {@link PermissionDecision}. Kept
 * separate from {@link PermissionPolicy} itself so the policy stays a pure
 * `request -> verdict` function while decision construction (timestamps,
 * default-deny wording, `NO_MATCH` handling) lives in one place — used by
 * both `PermissionManager` and anything that wants to preview a policy's
 * verdict without a full manager.
 */
export function decisionFromPolicyVerdict(
  request: PermissionRequest,
  verdict: { readonly effect: PolicyRuleEffect | 'NO_MATCH'; readonly reason: string; readonly ruleId?: string },
  defaultEffect: PolicyRuleEffect,
  now: () => Date,
): PermissionDecision {
  const decidedAt = now().toISOString();
  const effect = verdict.effect === 'NO_MATCH' ? defaultEffect : verdict.effect;
  const reason = verdict.effect === 'NO_MATCH' ? `No policy rule matched; falling back to default effect (${defaultEffect})` : verdict.reason;
  const policyId = verdict.ruleId ?? (verdict.effect === 'NO_MATCH' ? 'system.default-policy' : undefined);

  if (effect === 'ALLOW') {
    return allowDecision({
      request,
      reason,
      ...(policyId !== undefined ? { policyId } : {}),
      decidedAt,
      grantedScope: request.scope ?? { kind: 'global' },
      // A policy-rule ALLOW is re-evaluated on every check — it is never
      // itself persisted as a grant (see `manager.ts`'s doc comment), so
      // it's modeled as a `session`-lifetime decision: valid right now,
      // not something a store needs to remember.
      lifetime: 'session',
    });
  }
  if (effect === 'DENY') {
    return denyDecision({ request, reason, ...(policyId !== undefined ? { policyId } : {}), decidedAt });
  }
  return promptDecision({ request, reason, ...(policyId !== undefined ? { policyId } : {}), decidedAt });
}

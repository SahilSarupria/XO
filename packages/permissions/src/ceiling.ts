import type { PermissionDomain } from './domain.js';
import { permissionDomain } from './permission-id.js';
import type { PermissionPolicy } from './policy.js';
import type { PermissionRequest } from './request.js';

type Verdict = ReturnType<PermissionPolicy['evaluate']>;

export interface DomainCeilingPolicyOptions {
  /** The permission domain the ceiling governs (for example `workspace`). */
  readonly domain: PermissionDomain;
  /** Decides the most that may be allowed in `domain` (for example a role table). Only its `ALLOW` counts. */
  readonly ceiling: PermissionPolicy;
  /** Every other decision, and the only thing that may narrow `domain` further (by an explicit `DENY`). */
  readonly inner: PermissionPolicy;
}

/**
 * UW-1 (ADR 0010): one policy object for the single authorization point, in which one domain has a hard ceiling.
 *
 * For a request in `domain`:
 *  - an explicit `DENY` from `inner` wins (an operator can suspend one principal or one permission at once);
 *  - otherwise the request is allowed only if `ceiling` returns `ALLOW`;
 *  - anything else is an explicit `DENY`, never `NO_MATCH`. That matters: `PermissionManager` lets a stored grant stand when the
 *    policy says `NO_MATCH`, so returning `NO_MATCH` here would let a stored grant (or an operator's broad `ALLOW`) widen the ceiling.
 *    An `ALLOW` or `PROMPT` from `inner` therefore never widens the ceiling.
 * For every other domain the verdict is `inner`'s, unchanged.
 *
 * A policy that throws is not caught here: `PermissionManager`'s callers treat an exception as a denial (fail closed).
 */
export class DomainCeilingPolicy implements PermissionPolicy {
  readonly domain: PermissionDomain;
  private readonly ceiling: PermissionPolicy;
  private readonly inner: PermissionPolicy;

  constructor(options: DomainCeilingPolicyOptions) {
    this.domain = options.domain;
    this.ceiling = options.ceiling;
    this.inner = options.inner;
  }

  evaluate(request: PermissionRequest): Verdict {
    if (permissionDomain(request.permission) !== this.domain) return this.inner.evaluate(request);
    const narrowed = this.inner.evaluate(request);
    if (narrowed.effect === 'DENY') return narrowed;
    const ceiling = this.ceiling.evaluate(request);
    if (ceiling.effect === 'ALLOW') return ceiling;
    return {
      effect: 'DENY',
      reason: `not within the ${this.domain} ceiling (${ceiling.reason})`,
      ...(ceiling.ruleId !== undefined ? { ruleId: ceiling.ruleId } : {}),
    };
  }

  /** `PermissionManager` reads this for its default-effect reporting; outside the ceiling domain the inner default applies. */
  getDefaultEffect(): 'ALLOW' | 'DENY' | 'PROMPT' {
    const inner = (this.inner as { getDefaultEffect?: () => 'ALLOW' | 'DENY' | 'PROMPT' }).getDefaultEffect;
    return typeof inner === 'function' ? inner.call(this.inner) : 'DENY';
  }
}

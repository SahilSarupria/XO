import { err, ok, type PackageId, type Result } from '@xo/types';
import { ErrorCode, PermissionError } from '@xo/errors';
import { Clock, SystemClock } from './clock.js';
import { PermissionConsentProvider } from './consent.js';
import { noopAuditSink, type PermissionAuditEvent, type PermissionAuditSink } from './audit.js';
import { allowDecision, denyDecision, type PermissionDecision, type PermissionLifetime } from './decision.js';
import { computeGrantId, type PermissionGrant, type PermissionGrantFilter } from './grant.js';
import { parsePermissionId, type PermissionId } from './permission-id.js';
import { decisionFromPolicyVerdict, type PermissionPolicy } from './policy.js';
import type { PermissionRequest } from './request.js';
import { scopeContains, scopeSpecificity, scopeWithinRequest, isPermissionScope, globalScope, type PermissionScope } from './scope.js';
import { InMemoryPermissionStore, type PermissionStore } from './store.js';

export interface PermissionManagerOptions {
  readonly policy: PermissionPolicy;
  /** Defaults to a fresh {@link InMemoryPermissionStore} — fine for tests and for hosts that only need `once`/`session` lifetimes; a host that needs `persistent` grants to survive a restart must supply a durable backend. */
  readonly store?: PermissionStore;
  readonly auditSink?: PermissionAuditSink;
  /** Absent by default — see §10: with no provider, a `prompt` decision from `request()` stays unresolved rather than collapsing to `allow` or `deny`. */
  readonly consentProvider?: PermissionConsentProvider;
  readonly clock?: Clock;
}

export type RevocationTarget =
  | Readonly<{ kind: 'permission'; packageId: PackageId; permission: PermissionId }>
  | Readonly<{ kind: 'scoped'; packageId: PackageId; permission: PermissionId; scope: PermissionScope }>
  | Readonly<{ kind: 'capability'; packageId: PackageId; capabilityId: string }>
  | Readonly<{ kind: 'package'; packageId: PackageId }>
  | Readonly<{ kind: 'all' }>;

export interface GrantParams {
  readonly packageId: PackageId;
  readonly permission: PermissionId;
  readonly scope?: PermissionScope;
  readonly lifetime?: Extract<PermissionLifetime, 'session' | 'persistent'>;
  readonly requesterCapabilityId?: string;
}

/**
 * §9's central orchestration layer. Combines, for every decision:
 *
 *   registered policy rules (`policy`)
 * + persisted `allow` grants, `session` and `persistent` alike (`store`)
 * + the request's own context
 *
 * — see the class-level split between {@link PermissionManager.check} (no
 * side effects, never prompts) and {@link PermissionManager.request}
 * (identical to `check`, except a `prompt` outcome may additionally be
 * resolved via the configured `consentProvider`). Every method that
 * produces a `PermissionDecision` is audited (§17); every method that
 * touches the store returns a `Result` (§2.7/`@xo/storage` convention),
 * since the store can genuinely fail even when the *decision itself* — an
 * allow/deny/prompt value — never does.
 */
export class PermissionManager {
  private readonly policy: PermissionPolicy;
  private readonly store: PermissionStore;
  private readonly auditSink: PermissionAuditSink;
  private readonly consentProvider: PermissionConsentProvider | undefined;
  private readonly clock: Clock;

  constructor(options: PermissionManagerOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new InMemoryPermissionStore();
    this.auditSink = options.auditSink ?? noopAuditSink;
    this.consentProvider = options.consentProvider;
    this.clock = options.clock ?? new SystemClock();
  }

  /**
   * Determines whether `request` is already permitted, without ever
   * triggering user interaction (§9's required split from `request`).
   * Combines stored grants and policy rules; a malformed `request.permission`
   * fails closed to `deny` rather than throwing (§18).
   */
  async check(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = await this.evaluateCore(request);
    this.audit('permission.requested', request);
    this.auditForEffect(decision, request);
    return decision;
  }

  /**
   * Identical to {@link check}, except a resulting `prompt` decision may
   * additionally be resolved through the configured `consentProvider`.
   * With no provider configured, behaves exactly like `check` — the
   * `prompt` decision is returned unresolved, never silently upgraded to
   * `allow` (§10, §18's "no implicit trust").
   */
  async request(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = await this.evaluateCore(request);
    this.audit('permission.requested', request);

    if (decision.effect !== 'prompt') {
      this.auditForEffect(decision, request);
      return decision;
    }

    this.audit('permission.prompted', request);

    if (!this.consentProvider) {
      return decision; // stays `prompt`, unresolved — see class doc comment
    }

    const consent = await this.consentProvider.requestConsent(request);
    const decidedAt = this.clock.now().toISOString();

    if (!consent.granted) {
      const denied = denyDecision({
        request,
        reason: consent.reason ?? 'Consent declined',
        policyId: 'consent.declined',
        consentInvolved: true,
        decidedAt,
      });
      this.audit('permission.denied', request, { via: 'consent' });
      return denied;
    }

    const lifetime = consent.lifetime ?? 'once';
    // Consent may only narrow what was requested, never widen it (§18's
    // no-escalation guarantee applies to consent just as much as to
    // policy/store grants). Enforced, not just documented: a consent
    // scope that is malformed, or that is not contained within the
    // request's own scope (`scopeWithinRequest`), is rejected outright —
    // the resulting decision is `deny`, and no grant is ever created for
    // it. This is deliberately a hard failure, not a silent clamp/fallback
    // to the requested scope: silently substituting a "safe" scope would
    // hide a bug (or an attack) in whatever produced `consent.scope`
    // instead of surfacing it.
    if (consent.scope !== undefined && (!isPermissionScope(consent.scope) || !scopeWithinRequest(request.scope, consent.scope))) {
      const rejected = denyDecision({
        request,
        reason: 'Consent scope was rejected: it must be the same as, or narrower than, the requested scope (malformed scope or an attempted widening)',
        policyId: 'system.fail-closed',
        consentInvolved: true,
        decidedAt,
      });
      this.audit('permission.denied', request, { via: 'consent', reason: 'scope-escalation-rejected' });
      return rejected;
    }
    const grantedScope = consent.scope ?? request.scope ?? globalScope();

    let persisted = false;
    if (lifetime !== 'once') {
      const grant: PermissionGrant = {
        id: computeGrantId(request.requester.packageId, request.permission, grantedScope),
        permission: request.permission,
        scope: grantedScope,
        packageId: request.requester.packageId,
        ...(request.requester.capabilityId !== undefined ? { requesterCapabilityId: request.requester.capabilityId } : {}),
        lifetime,
        consentInvolved: true,
        grantedAt: decidedAt,
      };
      const setResult = await this.store.set(grant);
      persisted = setResult.ok;
      if (persisted) {
        this.audit('permission.granted', request, { lifetime, via: 'consent' });
      }
      // A store failure here does not invalidate the person's consent for
      // *this* operation — see the class doc comment ("revoking a
      // permission can't undo an already-happened operation", the
      // symmetric case: a storage hiccup can't undo a decision a human
      // already made). It does mean the grant won't survive to the next
      // check, so `persisted` stays false and the decision reflects that
      // honestly rather than claiming persistence that didn't happen.
    }

    const allowed = allowDecision({
      request,
      reason: consent.reason ?? 'Granted via consent',
      policyId: 'consent.granted',
      consentInvolved: true,
      decidedAt,
      grantedScope,
      lifetime,
      persistent: persisted,
    });
    this.audit('permission.allowed', request, { via: 'consent' });
    return allowed;
  }

  /**
   * Administrative grant — e.g. `xo permissions grant` (§22), or a Studio
   * "always allow" toggle acting outside the request/consent flow.
   * `consentInvolved` is always `false` on the resulting grant: this is
   * the host asserting a grant directly, not recording an in-the-moment
   * human response to a specific request (see {@link PermissionGrant}).
   */
  async grant(params: GrantParams): Promise<Result<PermissionGrant, PermissionError>> {
    const scope = params.scope ?? globalScope();
    const lifetime = params.lifetime ?? 'persistent';
    const grantRecord: PermissionGrant = {
      id: computeGrantId(params.packageId, params.permission, scope),
      permission: params.permission,
      scope,
      packageId: params.packageId,
      ...(params.requesterCapabilityId !== undefined ? { requesterCapabilityId: params.requesterCapabilityId } : {}),
      lifetime,
      consentInvolved: false,
      grantedAt: this.clock.now().toISOString(),
    };
    const setResult = await this.store.set(grantRecord);
    if (!setResult.ok) return err(setResult.error);
    this.auditSink.record({
      type: 'permission.granted',
      at: grantRecord.grantedAt,
      permission: grantRecord.permission,
      requesterPackageId: grantRecord.packageId,
      ...(grantRecord.requesterCapabilityId !== undefined ? { requesterCapabilityId: grantRecord.requesterCapabilityId } : {}),
      scope: grantRecord.scope,
      details: { via: 'admin', lifetime },
    });
    return ok(grantRecord);
  }

  /**
   * Removes matching `allow` grants immediately — future `check`/`request`
   * calls will no longer see them (§13's "revocation should take effect
   * immediately"). There is no persisted "deny grant" to insert in their
   * place (see `grant.ts`'s doc comment): after revocation, a future
   * request for the same permission falls through to the policy engine,
   * which default-denies unless another, still-standing rule allows it.
   *
   * Revocation cannot and does not affect an operation that has already
   * run using a now-revoked grant (§13) — this package has no way to know
   * what that operation did, let alone undo it; that's Runtime/Sandbox's
   * responsibility, not the Permission System's.
   */
  async revoke(target: RevocationTarget): Promise<Result<number, PermissionError>> {
    const filter: PermissionGrantFilter = target.kind === 'all' ? {} : { packageId: target.packageId };
    const listResult = await this.store.list(filter);
    if (!listResult.ok) return err(listResult.error);

    const toRevoke = listResult.value.filter((grant) => matchesRevocationTarget(grant, target));

    for (const grant of toRevoke) {
      const deleteResult = await this.store.delete(grant.id);
      if (!deleteResult.ok) return err(deleteResult.error);
      this.auditSink.record({
        type: 'permission.revoked',
        at: this.clock.now().toISOString(),
        permission: grant.permission,
        requesterPackageId: grant.packageId,
        ...(grant.requesterCapabilityId !== undefined ? { requesterCapabilityId: grant.requesterCapabilityId } : {}),
        scope: grant.scope,
        details: { targetKind: target.kind },
      });
    }

    return ok(toRevoke.length);
  }

  async list(filter?: PermissionGrantFilter): Promise<Result<readonly PermissionGrant[], PermissionError>> {
    return this.store.list(filter);
  }

  /**
   * Deletes every `session`-lifetime grant across all packages — call this
   * when the runtime/session that created them ends (§12: "a session
   * grant must disappear when the runtime/session ends"). `persistent`
   * grants are untouched.
   */
  async endSession(): Promise<Result<number, PermissionError>> {
    const listResult = await this.store.list({ lifetime: 'session' });
    if (!listResult.ok) return err(listResult.error);
    for (const grant of listResult.value) {
      const deleteResult = await this.store.delete(grant.id);
      if (!deleteResult.ok) return err(deleteResult.error);
    }
    return ok(listResult.value.length);
  }

  /**
   * Combines the policy engine and the persistent grant store into one
   * decision — §9's "registered policies + persistent grants + session
   * grants + request context". The precedence between an explicit policy
   * rule and a stored grant is a deliberate security choice, not an
   * accident of evaluation order:
   *
   * 1. **An explicit, matching policy `DENY` rule always overrides a
   *    stored grant.** This is what makes "emergency revocation through
   *    policy" possible (§3): a host can add one `DENY` rule and
   *    immediately override every existing grant for that
   *    permission/scope/package, without walking the store and deleting
   *    each grant individually. Note "explicit" — this is the policy
   *    engine actually matching a `DENY` rule, never the *default-deny
   *    fallback* that applies when nothing matches (`NO_MATCH`); the
   *    default fallback must not override a grant, or grants would be
   *    pointless (a grant exists precisely for permissions no policy
   *    rule covers).
   * 2. **Otherwise, a matching stored grant wins** — this is the normal
   *    case: most permissions have no explicit policy opinion at all, and
   *    a persisted `allow`/consent grant is exactly what's supposed to
   *    authorize them. This also covers `policy = ALLOW` (the grant and
   *    the policy agree) and `policy = NO_MATCH` (the grant is the only
   *    source of authorization) identically — both let the grant stand.
   * 3. **No matching grant** falls through to the policy verdict exactly
   *    as before (`ALLOW`/`PROMPT`/default-`DENY`).
   *
   * `policy.evaluate` is pure and synchronous (see `policy.ts`), and the
   * store lookup's own tiebreak (most specific grant wins, see
   * `scopeSpecificity`) doesn't depend on insertion order either — so the
   * combined result here never depends on insertion order, only on
   * (request, policy state, store state), matching §3/§18's determinism
   * requirement.
   */
  private async evaluateCore(request: PermissionRequest): Promise<PermissionDecision> {
    const parsed = parsePermissionId(request.permission);
    if (!parsed.ok) {
      return denyDecision({
        request,
        reason: `Fail-closed: ${parsed.error}`,
        policyId: 'system.fail-closed',
        decidedAt: this.clock.now().toISOString(),
      });
    }

    const verdict = this.policy.evaluate(request);
    const defaultEffect = this.getPolicyDefaultEffect();

    // An explicit policy DENY overrides any stored grant — see this
    // method's doc comment for why this is the one case evaluated before
    // the store lookup below.
    if (verdict.effect === 'DENY') {
      return decisionFromPolicyVerdict(request, verdict, defaultEffect, () => this.clock.now());
    }

    const listResult = await this.store.list({ packageId: request.requester.packageId, permission: request.permission });
    if (!listResult.ok) {
      return denyDecision({
        request,
        reason: `Fail-closed: permission store unavailable (${listResult.error.message})`,
        policyId: 'system.fail-closed',
        decidedAt: this.clock.now().toISOString(),
      });
    }

    const matchingGrants = listResult.value.filter((grant) => scopeContains(grant.scope, request.scope));
    if (matchingGrants.length > 0) {
      // Most specific stored grant wins, mirroring the policy engine's
      // own precedence rule — see policy.ts's doc comment. Final,
      // deterministic tiebreak on grant id if specificity is ever tied
      // (not reachable today given how `computeGrantId` dedupes, but
      // cheap insurance against ever depending on store iteration order).
      matchingGrants.sort((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope) || a.id.localeCompare(b.id));
      const grant = matchingGrants[0]!;
      return allowDecision({
        request,
        reason: `Authorized by stored grant "${grant.id}"`,
        policyId: 'store.grant',
        consentInvolved: grant.consentInvolved,
        decidedAt: this.clock.now().toISOString(),
        grantedScope: grant.scope,
        lifetime: grant.lifetime,
        persistent: true,
      });
    }

    return decisionFromPolicyVerdict(request, verdict, defaultEffect, () => this.clock.now());
  }

  private getPolicyDefaultEffect(): 'ALLOW' | 'DENY' | 'PROMPT' {
    const maybeDefault = (this.policy as { getDefaultEffect?: () => 'ALLOW' | 'DENY' | 'PROMPT' }).getDefaultEffect;
    return typeof maybeDefault === 'function' ? maybeDefault.call(this.policy) : 'DENY';
  }

  private audit(type: PermissionAuditEvent['type'], request: PermissionRequest, details?: Record<string, unknown>): void {
    const event: PermissionAuditEvent = {
      type,
      at: this.clock.now().toISOString(),
      permission: request.permission,
      requesterPackageId: request.requester.packageId,
      ...(request.requester.capabilityId !== undefined ? { requesterCapabilityId: request.requester.capabilityId } : {}),
      ...(request.scope !== undefined ? { scope: request.scope } : {}),
      ...(details !== undefined ? { details } : {}),
    };
    this.auditSink.record(event);
  }

  private auditForEffect(decision: PermissionDecision, request: PermissionRequest, details?: Record<string, unknown>): void {
    const type: PermissionAuditEvent['type'] = decision.effect === 'allow' ? 'permission.allowed' : decision.effect === 'deny' ? 'permission.denied' : 'permission.prompted';
    this.audit(type, request, details);
  }
}

function matchesRevocationTarget(grant: PermissionGrant, target: RevocationTarget): boolean {
  switch (target.kind) {
    case 'all':
      return true;
    case 'package':
      return grant.packageId === target.packageId;
    case 'permission':
      return grant.packageId === target.packageId && grant.permission === target.permission;
    case 'capability':
      return grant.packageId === target.packageId && grant.requesterCapabilityId === target.capabilityId;
    case 'scoped':
      return grant.packageId === target.packageId && grant.permission === target.permission && JSON.stringify(grant.scope) === JSON.stringify(target.scope);
  }
}

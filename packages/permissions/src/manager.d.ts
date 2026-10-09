import { type PackageId, type Result } from '@xo/types';
import { PermissionError } from '@xo/errors';
import { Clock } from './clock.js';
import { PermissionConsentProvider } from './consent.js';
import { type PermissionAuditSink } from './audit.js';
import { type PermissionDecision, type PermissionLifetime } from './decision.js';
import { type PermissionGrant, type PermissionGrantFilter } from './grant.js';
import { type PermissionId } from './permission-id.js';
import { type PermissionPolicy } from './policy.js';
import type { PermissionRequest } from './request.js';
import { type PermissionScope } from './scope.js';
import { type PermissionStore } from './store.js';
export interface PermissionManagerOptions {
    readonly policy: PermissionPolicy;
    /** Defaults to a fresh {@link InMemoryPermissionStore} — fine for tests and for hosts that only need `once`/`session` lifetimes; a host that needs `persistent` grants to survive a restart must supply a durable backend. */
    readonly store?: PermissionStore;
    readonly auditSink?: PermissionAuditSink;
    /** Absent by default — see §10: with no provider, a `prompt` decision from `request()` stays unresolved rather than collapsing to `allow` or `deny`. */
    readonly consentProvider?: PermissionConsentProvider;
    readonly clock?: Clock;
}
export type RevocationTarget = Readonly<{
    kind: 'permission';
    packageId: PackageId;
    permission: PermissionId;
}> | Readonly<{
    kind: 'scoped';
    packageId: PackageId;
    permission: PermissionId;
    scope: PermissionScope;
}> | Readonly<{
    kind: 'capability';
    packageId: PackageId;
    capabilityId: string;
}> | Readonly<{
    kind: 'package';
    packageId: PackageId;
}> | Readonly<{
    kind: 'all';
}>;
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
export declare class PermissionManager {
    private readonly policy;
    private readonly store;
    private readonly auditSink;
    private readonly consentProvider;
    private readonly clock;
    constructor(options: PermissionManagerOptions);
    /**
     * Determines whether `request` is already permitted, without ever
     * triggering user interaction (§9's required split from `request`).
     * Combines stored grants and policy rules; a malformed `request.permission`
     * fails closed to `deny` rather than throwing (§18).
     */
    check(request: PermissionRequest): Promise<PermissionDecision>;
    /**
     * Identical to {@link check}, except a resulting `prompt` decision may
     * additionally be resolved through the configured `consentProvider`.
     * With no provider configured, behaves exactly like `check` — the
     * `prompt` decision is returned unresolved, never silently upgraded to
     * `allow` (§10, §18's "no implicit trust").
     */
    request(request: PermissionRequest): Promise<PermissionDecision>;
    /**
     * Administrative grant — e.g. `xo permissions grant` (§22), or a Studio
     * "always allow" toggle acting outside the request/consent flow.
     * `consentInvolved` is always `false` on the resulting grant: this is
     * the host asserting a grant directly, not recording an in-the-moment
     * human response to a specific request (see {@link PermissionGrant}).
     */
    grant(params: GrantParams): Promise<Result<PermissionGrant, PermissionError>>;
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
    revoke(target: RevocationTarget): Promise<Result<number, PermissionError>>;
    list(filter?: PermissionGrantFilter): Promise<Result<readonly PermissionGrant[], PermissionError>>;
    /**
     * Deletes every `session`-lifetime grant across all packages — call this
     * when the runtime/session that created them ends (§12: "a session
     * grant must disappear when the runtime/session ends"). `persistent`
     * grants are untouched.
     */
    endSession(): Promise<Result<number, PermissionError>>;
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
    private evaluateCore;
    private getPolicyDefaultEffect;
    private audit;
    private auditForEffect;
}
//# sourceMappingURL=manager.d.ts.map
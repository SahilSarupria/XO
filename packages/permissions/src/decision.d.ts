import type { PermissionRequest } from './request.js';
import type { PermissionScope } from './scope.js';
/** §7's three required decision states. No `allow_once`/`deny_persistent` etc. at this level — those are *lifetimes* of an `allow` (see {@link PermissionLifetime}), kept as a separate axis so this union stays exactly as large as §7 asks ("do not create unnecessary complexity"). */
export type PermissionEffect = 'allow' | 'deny' | 'prompt';
/**
 * How long an `allow` decision remains valid without being re-decided:
 * - `once` — valid for a single authorized operation, then consumed.
 *   Never persisted to a `PermissionStore` (see `manager.ts`); that
 *   non-persistence *is* the consumption mechanism.
 * - `session` — valid until `PermissionManager.endSession()` is called
 *   (or, for a store backed by non-durable storage, until the process
 *   restarts). Persisted to the store, but the store is expected not to
 *   outlive the session unless the host chooses a durable backend anyway.
 * - `persistent` — valid across process restarts, for as long as the
 *   backing store keeps it, until explicitly revoked.
 */
export type PermissionLifetime = 'once' | 'session' | 'persistent';
/**
 * The outcome of evaluating a {@link PermissionRequest} — §7's required
 * shape ("what was requested, whether allowed, which policy caused it,
 * whether consent was involved, what scope was granted, when, whether
 * persistent"). Always a plain value, never thrown: a `deny` (including a
 * fail-closed deny for a malformed request) is exactly as valid and
 * expected an outcome as an `allow` — see `@xo/errors`' `PermissionError`
 * doc comment for why infrastructure failures are kept on a separate,
 * throwing path instead of overloading this type with an error case.
 */
export interface PermissionDecision {
    readonly request: PermissionRequest;
    readonly effect: PermissionEffect;
    /** Human-readable explanation — always present, even for `allow`, so every decision is self-explanatory in an audit log without cross-referencing policy source. */
    readonly reason: string;
    /** Id of the policy rule (or `"system.fail-closed"` / `"system.default-deny"` / `"store.grant"`) that produced this decision. Absent only for a `prompt` decision with no consent provider configured, where nothing "caused" the outcome beyond the absence of a rule. */
    readonly policyId?: string;
    readonly consentInvolved: boolean;
    /** The scope actually authorized — may be narrower than `request.scope` if a consent provider or admin grant chose to narrow it. Present only for `allow`. */
    readonly grantedScope?: PermissionScope;
    /** Present only for `allow` — see {@link PermissionLifetime}. */
    readonly lifetime?: PermissionLifetime;
    readonly decidedAt: string;
    /** Whether this decision was written to a `PermissionStore` (true only for `allow` with `lifetime` `session`/`persistent`, and only once the write actually succeeded). */
    readonly persistent: boolean;
}
export interface DecisionInput {
    readonly request: PermissionRequest;
    readonly reason: string;
    readonly policyId?: string;
    readonly consentInvolved?: boolean;
    readonly decidedAt: string;
}
export declare function allowDecision(input: DecisionInput & {
    readonly grantedScope: PermissionScope;
    readonly lifetime: PermissionLifetime;
    readonly persistent?: boolean;
}): PermissionDecision;
export declare function denyDecision(input: DecisionInput): PermissionDecision;
export declare function promptDecision(input: DecisionInput): PermissionDecision;
//# sourceMappingURL=decision.d.ts.map
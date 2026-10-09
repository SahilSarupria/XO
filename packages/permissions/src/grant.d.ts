import type { PackageId } from '@xo/types';
import type { PermissionId } from './permission-id.js';
import type { PermissionScope } from './scope.js';
/**
 * A persisted `allow` decision — the only thing a {@link
 * import('./store.js').PermissionStore} ever holds. There is
 * deliberately no persisted "deny grant": §7/§14's precedence model (see
 * `policy.ts`'s doc comment) makes the policy engine the single source of
 * truth for `deny`, so revocation (§13) only ever needs to *remove* an
 * allow grant, never insert a competing deny record. Two independent,
 * possibly-conflicting persistence paths for "allow" and "deny" would be
 * exactly the kind of "second permission model" §24 forbids.
 */
export interface PermissionGrant {
    /** Deterministic — see {@link computeGrantId}. Re-granting the same (package, permission, scope) upserts in place rather than accumulating duplicates. */
    readonly id: string;
    readonly permission: PermissionId;
    readonly scope: PermissionScope;
    readonly packageId: PackageId;
    /** The capability that was executing when this grant was created, if any — provenance for §13's "revoke capability permissions", distinct from `scope.kind === 'capability'` (which instead *restricts where the grant applies*, see `scope.ts`). */
    readonly requesterCapabilityId?: string;
    readonly lifetime: Extract<import('./decision.js').PermissionLifetime, 'session' | 'persistent'>;
    readonly consentInvolved: boolean;
    readonly grantedAt: string;
}
export declare function computeGrantId(packageId: PackageId, permission: PermissionId, scope: PermissionScope): string;
export interface PermissionGrantFilter {
    readonly packageId?: PackageId;
    readonly permission?: PermissionId;
    readonly capabilityId?: string;
    readonly lifetime?: Extract<import('./decision.js').PermissionLifetime, 'session' | 'persistent'>;
}
//# sourceMappingURL=grant.d.ts.map
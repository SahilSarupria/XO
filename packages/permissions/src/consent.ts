import type { PermissionLifetime } from './decision.js';
import type { PermissionRequest } from './request.js';
import type { PermissionScope } from './scope.js';

/**
 * The outcome of asking a human (or another out-of-band authority) for
 * consent. `scope`/`lifetime` let the consent UI narrow what was actually
 * granted relative to what was requested (e.g. the request asked for
 * `filesystem.read` unscoped, the person only agreed to
 * `scope: path("/workspace")`) — {@link import('./manager.js').PermissionManager}
 * always honors the narrower of the two, never widens.
 */
export interface PermissionConsent {
  readonly granted: boolean;
  /** Defaults to `'once'` if `granted` and omitted — the most conservative lifetime, matching §10/§18's "never silently grant more than asked". */
  readonly lifetime?: PermissionLifetime;
  readonly scope?: PermissionScope;
  readonly reason?: string;
}

/**
 * The seam a host (Studio, CLI, a future mobile app) implements to show an
 * actual consent UI. §10 is explicit that this package must never
 * implement one itself, and must never silently grant a permission purely
 * because no provider is configured — see
 * {@link import('./manager.js').PermissionManager}'s `request()` for how
 * an absent provider is handled (the decision stays `prompt`, unresolved,
 * rather than collapsing to `allow`).
 */
export interface PermissionConsentProvider {
  requestConsent(request: PermissionRequest): Promise<PermissionConsent>;
}

/**
 * A provider that always declines, for hosts/tests that want `prompt`
 * decisions to resolve deterministically to `deny` without wiring a real
 * UI. Deliberately not a default anywhere in this package — an explicit
 * opt-in, never silently substituted for "no provider configured".
 */
export const denyAllConsentProvider: PermissionConsentProvider = {
  async requestConsent(): Promise<PermissionConsent> {
    return { granted: false, reason: 'No consent UI configured; denyAllConsentProvider declines by design' };
  },
};

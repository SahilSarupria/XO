/**
 * A provider that always declines, for hosts/tests that want `prompt`
 * decisions to resolve deterministically to `deny` without wiring a real
 * UI. Deliberately not a default anywhere in this package — an explicit
 * opt-in, never silently substituted for "no provider configured".
 */
export const denyAllConsentProvider = {
    async requestConsent() {
        return { granted: false, reason: 'No consent UI configured; denyAllConsentProvider declines by design' };
    },
};
//# sourceMappingURL=consent.js.map
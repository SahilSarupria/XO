/**
 * Compares two raw version strings for deterministic ordering.
 * `@xo/package-sdk`'s `compareSemVer` operates on parsed `SemVer`
 * values, not raw strings, and a manifest's `version` is only guaranteed
 * well-formed semver by the time it passed `PackageValidator` at install
 * — a defensive caller here still falls back to a plain lexical compare
 * for a malformed version rather than throwing, since ordering a listing
 * deterministically must never fail even when a version string can't be
 * parsed.
 */
export declare function compareVersionStrings(a: string, b: string): number;
//# sourceMappingURL=version-order.d.ts.map
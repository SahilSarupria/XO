import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
/**
 * A parsed semantic version (semver.org). Hand-rolled rather than an
 * external dependency: the grammar this SDK actually needs — parse,
 * compare, classify a bump — is small and stable enough that pulling in
 * `node-semver` would be more surface area than the SDK exercises.
 */
export interface SemVer {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
    readonly build: readonly string[];
    readonly raw: string;
}
export declare function isValidSemVer(value: string): boolean;
export declare function parseSemVer(value: string): Result<SemVer, PackageError>;
/** Returns -1, 0, or 1. Build metadata is ignored, per semver.org §10. */
export declare function compareSemVer(a: SemVer, b: SemVer): number;
export type VersionBump = 'major' | 'minor' | 'patch' | 'none' | 'invalid';
/** Classifies the step from `from` to `to`. Returns `'invalid'` if either string fails to parse, or if `to` is not strictly greater than `from`. */
export declare function classifyBump(from: string, to: string): VersionBump;
/**
 * Semver *range* support — added for `@xo/package-sdk`'s dependency
 * resolver (`resolver/`), which is the first consumer in this codebase
 * that needs to ask "does version X satisfy requirement Y" instead of
 * just comparing two exact versions. The README's own "Known
 * limitations" section flagged this as the natural place to add range
 * matching if a consumer ever needed it, rather than reaching for
 * `node-semver` piecemeal — this is that addition, kept to the same
 * hand-rolled, dependency-free style as the rest of this file.
 *
 * Supported grammar (a deliberate subset of npm's range grammar, chosen
 * to cover what a dependency resolver actually needs, not full parity):
 *   - An exact version (`"1.2.3"`) matches only that version.
 *   - Comparator expressions: `=`, `>`, `>=`, `<`, `<=` followed by a
 *     version (e.g. `">=1.2.0"`).
 *   - Caret ranges (`"^1.2.3"`): compatible-with, npm semantics —
 *     locks the leftmost non-zero component.
 *   - Tilde ranges (`"~1.2.3"`): allows patch-level changes only.
 *   - Space-separated comparators are ANDed together (e.g.
 *     `">=1.0.0 <2.0.0"`), the same way `^`/`~` desugar internally.
 *   - `"*"` or `""` matches any valid version.
 * Not supported: comma/`||`-separated OR sets, `x`-ranges (`1.2.x`),
 * hyphen ranges (`"1.2.3 - 1.4.0"`). Nothing in this SDK currently needs
 * them; adding OR-set support is a natural next step in `SemVerRange` if
 * a future dependency declaration needs it, not a redesign.
 */
export interface SemVerComparator {
    readonly op: '=' | '>' | '>=' | '<' | '<=';
    readonly version: SemVer;
}
/** A parsed range: `comparators` are ANDed together (a version must satisfy every one). An empty `comparators` array (from `"*"` or `""`) matches any valid version. */
export interface SemVerRange {
    readonly comparators: readonly SemVerComparator[];
    readonly raw: string;
}
export declare function parseSemVerRange(range: string): Result<SemVerRange, PackageError>;
export declare function isValidSemVerRange(range: string): boolean;
/** Whether `version` (a parsed {@link SemVer}) satisfies every comparator in `range`. */
export declare function matchesRange(version: SemVer, range: SemVerRange): boolean;
/** Convenience wrapper combining `parseSemVer` + `parseSemVerRange` + `matchesRange`; fails (as an `err` Result) if either `version` or `range` doesn't parse, rather than treating an unparseable input as a silent non-match. */
export declare function satisfiesRange(version: string, range: string): Result<boolean, PackageError>;
//# sourceMappingURL=semver.d.ts.map
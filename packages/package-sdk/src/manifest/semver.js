import { err, ok } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
const SEMVER_RE = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function isValidSemVer(value) {
    return SEMVER_RE.test(value);
}
export function parseSemVer(value) {
    const match = SEMVER_RE.exec(value);
    if (!match?.groups) {
        return err(new PackageError(ErrorCode.PACKAGE_VERSION_INVALID, `"${value}" is not a valid semantic version`));
    }
    const { major, minor, patch, prerelease, build } = match.groups;
    return ok({
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        prerelease: prerelease ? prerelease.split('.') : [],
        build: build ? build.split('.') : [],
        raw: value,
    });
}
function comparePrerelease(a, b) {
    // No prerelease > has prerelease (1.0.0 > 1.0.0-rc.1), per semver.org §11.
    if (a.length === 0 && b.length === 0)
        return 0;
    if (a.length === 0)
        return 1;
    if (b.length === 0)
        return -1;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const ai = a[i];
        const bi = b[i];
        if (ai === undefined)
            return -1;
        if (bi === undefined)
            return 1;
        const an = /^\d+$/.test(ai);
        const bn = /^\d+$/.test(bi);
        if (an && bn) {
            const diff = Number(ai) - Number(bi);
            if (diff !== 0)
                return Math.sign(diff);
        }
        else if (an !== bn) {
            return an ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
        }
        else if (ai !== bi) {
            return ai < bi ? -1 : 1;
        }
    }
    return 0;
}
/** Returns -1, 0, or 1. Build metadata is ignored, per semver.org §10. */
export function compareSemVer(a, b) {
    if (a.major !== b.major)
        return Math.sign(a.major - b.major);
    if (a.minor !== b.minor)
        return Math.sign(a.minor - b.minor);
    if (a.patch !== b.patch)
        return Math.sign(a.patch - b.patch);
    return comparePrerelease(a.prerelease, b.prerelease);
}
/** Classifies the step from `from` to `to`. Returns `'invalid'` if either string fails to parse, or if `to` is not strictly greater than `from`. */
export function classifyBump(from, to) {
    const fromResult = parseSemVer(from);
    const toResult = parseSemVer(to);
    if (!fromResult.ok || !toResult.ok)
        return 'invalid';
    const a = fromResult.value;
    const b = toResult.value;
    if (compareSemVer(a, b) === 0)
        return 'none';
    if (compareSemVer(a, b) > 0)
        return 'invalid';
    if (a.major !== b.major)
        return 'major';
    if (a.minor !== b.minor)
        return 'minor';
    return 'patch';
}
const COMPARATOR_RE = /^(?<op>=|>=|<=|>|<)?(?<version>\S+)$/;
function caretUpperBound(v) {
    if (v.major > 0)
        return `${v.major + 1}.0.0`;
    if (v.minor > 0)
        return `0.${v.minor + 1}.0`;
    return `0.0.${v.patch + 1}`;
}
/** Expands a single `^`/`~` token into its two-comparator equivalent (e.g. `"^1.2.3"` -> `[">=1.2.3", "<2.0.0"]`), or returns `null` if `token` isn't a caret/tilde shorthand. */
function expandShorthand(token) {
    const caret = /^\^(.+)$/.exec(token);
    if (caret?.[1]) {
        const base = parseSemVer(caret[1]);
        if (!base.ok)
            return null;
        return [`>=${base.value.raw}`, `<${caretUpperBound(base.value)}`];
    }
    const tilde = /^~(.+)$/.exec(token);
    if (tilde?.[1]) {
        const base = parseSemVer(tilde[1]);
        if (!base.ok)
            return null;
        return [`>=${base.value.raw}`, `<${base.value.major}.${base.value.minor + 1}.0`];
    }
    return null;
}
/** Parses a single ANDed comparator set (no shorthand expansion left in any token) into `SemVerComparator[]`, or `undefined` if any token is malformed. */
function parseComparators(tokens) {
    const comparators = [];
    for (const token of tokens) {
        const match = COMPARATOR_RE.exec(token);
        if (!match?.groups)
            return undefined;
        const op = (match.groups.op ?? '=');
        const parsed = parseSemVer(match.groups.version ?? '');
        if (!parsed.ok)
            return undefined;
        comparators.push({ op, version: parsed.value });
    }
    return comparators;
}
export function parseSemVerRange(range) {
    const trimmed = range.trim();
    if (trimmed === '' || trimmed === '*') {
        return ok({ comparators: [], raw: range });
    }
    const tokens = trimmed.split(/\s+/);
    const expanded = [];
    for (const token of tokens) {
        const shorthand = expandShorthand(token);
        if (shorthand)
            expanded.push(...shorthand);
        else
            expanded.push(token);
    }
    const comparators = parseComparators(expanded);
    if (!comparators) {
        return err(new PackageError(ErrorCode.PACKAGE_VERSION_INVALID, `"${range}" is not a valid semantic version range`));
    }
    return ok({ comparators, raw: range });
}
export function isValidSemVerRange(range) {
    return parseSemVerRange(range).ok;
}
/** Whether `version` (a parsed {@link SemVer}) satisfies every comparator in `range`. */
export function matchesRange(version, range) {
    if (range.comparators.length === 0)
        return true;
    return range.comparators.every((c) => {
        const cmp = compareSemVer(version, c.version);
        switch (c.op) {
            case '=':
                return cmp === 0;
            case '>':
                return cmp > 0;
            case '>=':
                return cmp >= 0;
            case '<':
                return cmp < 0;
            case '<=':
                return cmp <= 0;
        }
    });
}
/** Convenience wrapper combining `parseSemVer` + `parseSemVerRange` + `matchesRange`; fails (as an `err` Result) if either `version` or `range` doesn't parse, rather than treating an unparseable input as a silent non-match. */
export function satisfiesRange(version, range) {
    const parsedVersion = parseSemVer(version);
    if (!parsedVersion.ok)
        return parsedVersion;
    const parsedRange = parseSemVerRange(range);
    if (!parsedRange.ok)
        return parsedRange;
    return ok(matchesRange(parsedVersion.value, parsedRange.value));
}
//# sourceMappingURL=semver.js.map
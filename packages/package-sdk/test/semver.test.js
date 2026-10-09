import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBump, compareSemVer, isValidSemVer, isValidSemVerRange, parseSemVer, parseSemVerRange, satisfiesRange } from '../src/manifest/semver.js';
test('isValidSemVer accepts well-formed versions', () => {
    assert.equal(isValidSemVer('1.0.0'), true);
    assert.equal(isValidSemVer('0.1.0'), true);
    assert.equal(isValidSemVer('1.2.3-rc.1'), true);
    assert.equal(isValidSemVer('1.2.3+build.5'), true);
    assert.equal(isValidSemVer('1.2.3-rc.1+build.5'), true);
});
test('isValidSemVerRange accepts exact versions, comparator expressions, caret/tilde shorthand, ANDed sets, and wildcards', () => {
    assert.equal(isValidSemVerRange('1.2.3'), true);
    assert.equal(isValidSemVerRange('>=1.2.3'), true);
    assert.equal(isValidSemVerRange('<=2.0.0'), true);
    assert.equal(isValidSemVerRange('^1.2.3'), true);
    assert.equal(isValidSemVerRange('~1.2.3'), true);
    assert.equal(isValidSemVerRange('>=1.0.0 <2.0.0'), true);
    assert.equal(isValidSemVerRange('*'), true);
    assert.equal(isValidSemVerRange(''), true);
});
test('isValidSemVerRange rejects malformed ranges', () => {
    assert.equal(isValidSemVerRange('not-a-range'), false);
    assert.equal(isValidSemVerRange('^not-a-version'), false);
    assert.equal(isValidSemVerRange('>=1.0.0 <not-a-version'), false);
    assert.equal(isValidSemVerRange('!!1.2.3'), false);
});
test('parseSemVerRange treats an empty string or "*" as matching anything', () => {
    const empty = parseSemVerRange('');
    const star = parseSemVerRange('*');
    assert.ok(empty.ok && star.ok);
    assert.deepEqual(empty.value.comparators, []);
    assert.deepEqual(star.value.comparators, []);
});
test('satisfiesRange: an exact version range matches only that version', () => {
    assert.deepEqual(satisfiesRange('1.2.3', '1.2.3'), { ok: true, value: true });
    assert.deepEqual(satisfiesRange('1.2.4', '1.2.3'), { ok: true, value: false });
});
test('satisfiesRange: caret ranges lock the leftmost non-zero component (npm semantics)', () => {
    assert.equal(satisfiesRange('1.2.3', '^1.2.3').ok && satisfiesRange('1.2.3', '^1.2.3').value, true);
    assert.equal(satisfiesRange('1.9.9', '^1.2.3').value, true);
    assert.equal(satisfiesRange('2.0.0', '^1.2.3').value, false);
    // 0.x is treated as unstable: ^0.2.3 only allows patch-level changes.
    assert.equal(satisfiesRange('0.2.9', '^0.2.3').value, true);
    assert.equal(satisfiesRange('0.3.0', '^0.2.3').value, false);
});
test('satisfiesRange: tilde ranges allow only patch-level changes', () => {
    assert.equal(satisfiesRange('1.2.9', '~1.2.3').value, true);
    assert.equal(satisfiesRange('1.3.0', '~1.2.3').value, false);
});
test('satisfiesRange: space-separated comparators are ANDed together', () => {
    const range = '>=1.0.0 <2.0.0';
    assert.equal(satisfiesRange('1.0.0', range).value, true);
    assert.equal(satisfiesRange('1.9.9', range).value, true);
    assert.equal(satisfiesRange('2.0.0', range).value, false);
    assert.equal(satisfiesRange('0.9.9', range).value, false);
});
test('satisfiesRange returns an err Result for an unparseable version or range', () => {
    assert.equal(satisfiesRange('not-a-version', '^1.0.0').ok, false);
    assert.equal(satisfiesRange('1.0.0', 'not-a-range').ok, false);
});
test('isValidSemVer rejects malformed versions', () => {
    assert.equal(isValidSemVer('1.0'), false);
    assert.equal(isValidSemVer('v1.0.0'), false);
    assert.equal(isValidSemVer('1.0.0.0'), false);
    assert.equal(isValidSemVer('01.0.0'), false);
    assert.equal(isValidSemVer(''), false);
});
test('parseSemVer returns an err Result for invalid input', () => {
    const result = parseSemVer('not-a-version');
    assert.equal(result.ok, false);
});
test('compareSemVer orders major/minor/patch correctly', () => {
    const a = parseSemVer('1.2.3');
    const b = parseSemVer('1.3.0');
    assert.ok(a.ok && b.ok);
    assert.equal(compareSemVer(a.value, b.value), -1);
    assert.equal(compareSemVer(b.value, a.value), 1);
    assert.equal(compareSemVer(a.value, a.value), 0);
});
test('compareSemVer treats a release as greater than any prerelease of the same core version', () => {
    const release = parseSemVer('1.0.0');
    const rc = parseSemVer('1.0.0-rc.1');
    assert.ok(release.ok && rc.ok);
    assert.equal(compareSemVer(release.value, rc.value), 1);
});
test('classifyBump identifies major/minor/patch bumps', () => {
    assert.equal(classifyBump('1.0.0', '2.0.0'), 'major');
    assert.equal(classifyBump('1.0.0', '1.1.0'), 'minor');
    assert.equal(classifyBump('1.0.0', '1.0.1'), 'patch');
});
test('classifyBump returns none for an identical version', () => {
    assert.equal(classifyBump('1.0.0', '1.0.0'), 'none');
});
test('classifyBump returns invalid for a downgrade or malformed input', () => {
    assert.equal(classifyBump('2.0.0', '1.0.0'), 'invalid');
    assert.equal(classifyBump('not-semver', '1.0.0'), 'invalid');
    assert.equal(classifyBump('1.0.0', 'not-semver'), 'invalid');
});
//# sourceMappingURL=semver.test.js.map
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../lib/classify.mjs';
import { makeRedactor } from '../lib/redact.mjs';
import { EXIT } from '../visual.config.mjs';

const match = { id: 'desktop/home', status: 'match' };

test('all screens matching is a pass', () => {
  const v = classify({ results: [match, { ...match, id: 'mobile/home' }] });
  assert.equal(v.kind, 'pass');
  assert.equal(v.exitCode, EXIT.pass);
});

test('every non-matching status is a regression, with its own exit code', () => {
  for (const status of ['diff', 'size-mismatch', 'missing-baseline', 'functional']) {
    const v = classify({ results: [match, { id: 'x/y', status }] });
    assert.equal(v.kind, 'regression', status);
    assert.equal(v.exitCode, EXIT.regression);
  }
});

test('with no references at all the headline says so instead of claiming screens differ', () => {
  const v = classify({ results: [1, 2, 3].map((n) => ({ id: `d/${n}`, status: 'missing-baseline' })) });
  assert.match(v.headline, /none of the 3 screens has an approved reference/);
  assert.doesNotMatch(v.headline, /differ/);
});

test('a mixed result names each kind of problem with its count', () => {
  const v = classify({
    results: [match, { id: 'a', status: 'diff' }, { id: 'b', status: 'size-mismatch' }, { id: 'c', status: 'missing-baseline' }, { id: 'd', status: 'functional' }],
  });
  assert.match(v.headline, /4 of 5 screens need attention/);
  assert.match(v.headline, /2 differ from the approved references/);
  assert.match(v.headline, /1 have no approved reference/);
  assert.match(v.headline, /1 did not behave as expected/);
});

test('infrastructure failure outranks everything and has a different exit code from a regression', () => {
  const v = classify({ infraError: 'API did not start', results: [{ id: 'x/y', status: 'diff' }] });
  assert.equal(v.kind, 'infra');
  assert.equal(v.exitCode, EXIT.infra);
  assert.notEqual(EXIT.infra, EXIT.regression);
});

test('capturing nothing is never a pass', () => {
  assert.equal(classify({ results: [] }).kind, 'infra');
});

test('credentials are redacted: key shape, bearer tokens and exact known secrets', () => {
  const redact = makeRedactor(['correct-horse-battery']);
  const out = redact('key xoak_AbC123_-x and Authorization: Bearer abc.def-ghi and correct-horse-battery done');
  assert.ok(!out.includes('xoak_AbC123'));
  assert.ok(!out.includes('abc.def-ghi'));
  assert.ok(!out.includes('correct-horse-battery'));
  assert.match(out, /xoak_\[redacted\]/);
});

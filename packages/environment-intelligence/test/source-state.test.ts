import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_AXES, summarize, transition, type SourceAxes, type SourceEvent, type SourceSummaryStatus } from '../src/index.js';

function run(events: readonly SourceEvent[]): { axes: SourceAxes; ok: boolean; lastError?: string; purge: boolean } {
  let axes = INITIAL_AXES;
  let purge = false;
  for (const e of events) {
    const r = transition(axes, e);
    if (!r.ok) return { axes, ok: false, lastError: r.error.code, purge };
    axes = r.value.axes;
    purge = purge || r.value.purgeRequired;
  }
  return { axes, ok: true, purge };
}

test('every required summary status is reachable and distinct (nothing collapses to "connected")', () => {
  const cases: [SourceSummaryStatus, readonly SourceEvent[]][] = [
    ['detected', []],
    ['supported', ['connector_matched']],
    ['connection_required', ['connector_matched', 'connection_required']],
    ['authorization_required', ['connector_matched', 'connection_configured', 'authorization_required']],
    ['connected_and_validated', ['connector_matched', 'connection_configured', 'authorization_granted', 'connection_validated']],
    [
      'acquisition_successful',
      ['connector_matched', 'connection_configured', 'authorization_granted', 'connection_validated', 'acquisition_succeeded'],
    ],
    [
      'acquisition_partial',
      ['connector_matched', 'connection_configured', 'authorization_granted', 'connection_validated', 'acquisition_partial'],
    ],
    ['unsupported_or_inaccessible', ['connector_missing']],
    ['failed_or_unavailable', ['connector_matched', 'connection_configured', 'connection_failed']],
  ];
  const seen = new Set<string>();
  for (const [expected, events] of cases) {
    const r = run(events);
    assert.equal(r.ok, true, `${expected}: ${r.lastError}`);
    assert.equal(summarize(r.axes), expected);
    seen.add(expected);
  }
  assert.equal(seen.size, cases.length);
});

test('authorization denied is reported as inaccessible, not as connected', () => {
  const r = run(['connector_matched', 'connection_configured', 'authorization_denied']);
  assert.equal(summarize(r.axes), 'unsupported_or_inaccessible');
});

test('acquisition cannot be recorded without granted authorization AND a validated connection', () => {
  const noAuth = run(['connector_matched', 'connection_configured', 'connection_validated', 'acquisition_succeeded']);
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.lastError, 'EI_INVALID_TRANSITION');
  const noValidation = run(['connector_matched', 'connection_configured', 'authorization_granted', 'acquisition_succeeded']);
  assert.equal(noValidation.ok, false);
  assert.equal(noValidation.lastError, 'EI_INVALID_TRANSITION');
});

test('validation requires a matched connector and a configured connection', () => {
  assert.equal(run(['connection_validated']).ok, false);
  assert.equal(run(['connector_matched', 'connection_validated']).ok, false);
  assert.equal(run(['authorization_granted']).ok, false);
});

test('revocation discards the acquisition fact and flags that acquired evidence must be purged', () => {
  const r = run([
    'connector_matched',
    'connection_configured',
    'authorization_granted',
    'connection_validated',
    'acquisition_succeeded',
    'authorization_revoked',
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.axes.acquisition, 'not_attempted');
  assert.equal(r.purge, true);
  assert.equal(summarize(r.axes), 'authorization_required');
});

test('a failed connection can recover through reconfiguration and revalidation', () => {
  const r = run([
    'connector_matched',
    'connection_configured',
    'connection_failed',
    'connection_configured',
    'authorization_granted',
    'connection_validated',
  ]);
  assert.equal(r.ok, true);
  assert.equal(summarize(r.axes), 'connected_and_validated');
});

test('a rejected transition leaves the axes unchanged', () => {
  const before = INITIAL_AXES;
  const r = transition(before, 'acquisition_succeeded');
  assert.equal(r.ok, false);
  assert.deepEqual(before, INITIAL_AXES);
});

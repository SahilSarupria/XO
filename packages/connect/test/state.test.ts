import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../src/state.js';
import type { SourceConfig, SourceFacts } from '../src/ports.js';

const cfg = (over: Partial<SourceConfig> = {}): SourceConfig => ({
  ownerId: 'o',
  sourceId: 's',
  root: '/a/b',
  includeKeys: ['x'],
  excludedNames: [],
  disconnected: false,
  createdAt: 't',
  history: [],
  ...over,
});
const facts = (over: Partial<SourceFacts> = {}): SourceFacts => ({
  authorization: 'granted',
  connection: 'validated',
  acquisition: 'not_attempted',
  unavailable: false,
  ...over,
});

test('state mapping table', () => {
  assert.equal(deriveState(cfg(), facts()).state, 'awaiting_first_read');
  const read = (status: 'complete' | 'partial' | 'failed') => [
    {
      at: 't',
      kind: 'read' as const,
      read: {
        requested: 1,
        read: 1,
        unreadable: 0,
        skipped: { notIncluded: 0, notAcquirable: 0, vanished: 0 },
        status,
        errorCodes: [],
        evidence: 'not_retained' as const,
        retired: 0,
      },
    },
  ];
  // Platform acquisition=succeeded after listing alone must NOT read as "read complete".
  assert.equal(deriveState(cfg(), facts({ acquisition: 'succeeded' })).state, 'awaiting_first_read');
  assert.equal(deriveState(cfg({ history: read('complete') }), facts({ acquisition: 'succeeded' })).state, 'read_complete');
  assert.equal(deriveState(cfg({ history: read('partial') }), facts({ acquisition: 'succeeded' })).state, 'read_partial');
  assert.equal(deriveState(cfg({ history: read('failed') }), facts({ acquisition: 'succeeded' })).state, 'needs_attention');
  assert.equal(deriveState(cfg(), facts({ acquisition: 'failed' })).state, 'needs_attention');
  assert.equal(deriveState(cfg(), facts({ unavailable: true })).attention?.code, 'source_unavailable');
  assert.equal(deriveState(cfg(), facts({ authorization: 'denied' })).state, 'needs_attention');
  assert.equal(deriveState(cfg(), facts({ authorization: 'required', connection: 'configured' })).state, 'setup_incomplete');
});

test('revoked authorization is access_ended and never claims knowledge was removed or says why', () => {
  const d = deriveState(cfg(), facts({ authorization: 'revoked', acquisition: 'succeeded' }));
  assert.equal(d.state, 'access_ended');
  assert.match(d.attention?.message ?? '', /Earlier knowledge is kept/);
  assert.doesNotMatch(d.attention?.message ?? '', /expired|revoked|removed/);
});

test('connect-level stop wins over platform state; missing facts are never healthy', () => {
  assert.equal(deriveState(cfg({ disconnected: true }), facts({ acquisition: 'succeeded' })).state, 'disconnected');
  assert.equal(deriveState(cfg({ disconnected: true }), undefined).state, 'disconnected');
  assert.equal(deriveState(cfg(), undefined).state, 'setup_incomplete');
});

test('D-2: expired access is distinct from revoked, and neither removes knowledge', () => {
  const expired = deriveState(cfg(), facts({ authorization: 'revoked', endedReason: 'expired' }));
  assert.equal(expired.state, 'access_expired');
  assert.equal(deriveState(cfg(), facts({ authorization: 'revoked', endedReason: 'revoked' })).state, 'access_ended');
  assert.equal(deriveState(cfg(), facts({ authorization: 'revoked' })).state, 'access_ended');
  assert.match(expired.attention?.message ?? '', /Earlier knowledge is kept and may be out of date/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCapabilityId, computeCapabilityMatchKey, computeCapabilityRelationshipId, normalizeCapabilityName } from '../../src/capabilities/capability-id.js';

test('the worked example: Send Email / Email Sending / Mail Sender all merge to the same id', () => {
  const a = computeCapabilityId('communication', 'Send Email');
  const b = computeCapabilityId('communication', 'Email Sending');
  const c = computeCapabilityId('communication', 'Mail Sender');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('match key differs across categories for the same name', () => {
  const a = computeCapabilityMatchKey('communication', 'Send Email');
  const b = computeCapabilityMatchKey('action', 'Send Email');
  assert.notEqual(a, b);
});

test('genuinely different capability names do not collide', () => {
  const a = computeCapabilityId('analysis', 'Review Contract');
  const b = computeCapabilityId('analysis', 'Translate Document');
  assert.notEqual(a, b);
});

test('normalizeCapabilityName lowercases and strips punctuation', () => {
  assert.equal(normalizeCapabilityName('Send Email!'), 'send email');
});

test('computeCapabilityId has a stable, readable prefix', () => {
  const id = computeCapabilityId('action', 'x');
  assert.match(id, /^cap_[0-9a-f]{32}$/);
});

test('computeCapabilityRelationshipId is deterministic and direction-sensitive', () => {
  const a = computeCapabilityRelationshipId('depends_on', 'cap-1', 'cap-2');
  const b = computeCapabilityRelationshipId('depends_on', 'cap-1', 'cap-2');
  const reversed = computeCapabilityRelationshipId('depends_on', 'cap-2', 'cap-1');
  assert.equal(a, b);
  assert.notEqual(a, reversed);
});

test('stop words do not affect the match key', () => {
  const a = computeCapabilityMatchKey('action', 'Send the Email');
  const b = computeCapabilityMatchKey('action', 'Send Email');
  assert.equal(a, b);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleCandidateName, isPlausibleCommandIdentifier } from '../../src/capabilities/candidate-plausibility.js';

test('accepts real code-identifier shapes as plausible command identifiers (lowerCamelCase, dotted, snake_case)', () => {
  assert.equal(isPlausibleCommandIdentifier('sendEmail'), true);
  assert.equal(isPlausibleCommandIdentifier('xo.compile'), true);
  assert.equal(isPlausibleCommandIdentifier('process_order'), true);
  assert.equal(isPlausibleCommandIdentifier('doThing'), true);
});

test('rejects a bare capitalized word (no dot/underscore, starts uppercase) as an implausible command identifier', () => {
  // Building(s), Sion(E), Region(E), Renewal(s), Opted(Yes / No) — all real (or fixture-planted) parenthetical remarks after an
  // ordinary capitalized English word, not command/API usage.
  assert.equal(isPlausibleCommandIdentifier('Building'), false);
  assert.equal(isPlausibleCommandIdentifier('Sion'), false);
  assert.equal(isPlausibleCommandIdentifier('Region'), false);
  assert.equal(isPlausibleCommandIdentifier('Renewal'), false);
  assert.equal(isPlausibleCommandIdentifier('Opted'), false);
  assert.equal(isPlausibleCommandIdentifier('PlanOpted'), false);
});

test('rejects the empty identifier', () => {
  assert.equal(isPlausibleCommandIdentifier(''), false);
});

test('candidate names built from ordinary legible prose are plausible', () => {
  assert.equal(isPlausibleCandidateName('Contact the claims department'), true);
  assert.equal(isPlausibleCandidateName('Claim Assessment'), true);
  assert.equal(isPlausibleCandidateName('Send a confirmation notice'), true);
});

test('a candidate name containing even one suspicious token is rejected wholesale, not partially edited', () => {
  assert.equal(isPlausibleCandidateName('Contact and8827461093 QUICKSURE BROKERS'), false);
  assert.equal(isPlausibleCandidateName('NameOpted'), false);
});

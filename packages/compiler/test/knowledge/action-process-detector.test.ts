import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOperationalContent } from '../../src/knowledge/action-process-detector.js';

// --- Action positives (required by the milestone brief, §6) ---

test('bare imperative sentences are detected as action', () => {
  const positives = [
    'Install the dependency.',
    'Configure the environment.',
    'Restart the service.',
    'Deploy the service.',
    'Verify the health endpoint.',
    'Collect logs.',
    'Record the result.',
    'Match X against Y.',
    'Reconcile P with Q.',
    'Calculate Z.',
  ];
  for (const text of positives) {
    assert.equal(detectOperationalContent(text), 'action', `expected "${text}" -> action`);
  }
});

// --- Process positives ---

test('explicit composition language is detected as process', () => {
  assert.equal(detectOperationalContent('The process consists of A, B, and C.'), 'process');
  assert.equal(detectOperationalContent('The workflow comprises intake, review, and approval.'), 'process');
  assert.equal(detectOperationalContent('The pipeline is composed of extraction, transformation, and loading.'), 'process');
});

test('an explicit ordered sequence (two or more sequencing markers) is detected as process', () => {
  const text = 'First, collect the required documents. Then, verify the details. Finally, submit the application.';
  assert.equal(detectOperationalContent(text), 'process');
});

test('a single sequencing marker alone is not enough to trigger process (avoids over-firing on one "then")', () => {
  const text = 'Submit the form, then wait for confirmation.';
  assert.notEqual(detectOperationalContent(text), 'process');
});

// --- Negative / regression cases: precision requirement ---

test('a definition-shaped statement is not classified as action or process', () => {
  assert.equal(detectOperationalContent('"Confidential Information" means any non-public data disclosed by either party.'), undefined);
});

test('an obligation ("must"/"shall") statement is not classified as action, even though it contains an action verb', () => {
  assert.equal(detectOperationalContent('Employees must complete the training within 30 days of hire.'), undefined);
  assert.equal(detectOperationalContent('The Receiving Party shall maintain confidentiality of all disclosed information.'), undefined);
});

test('an exception statement is not classified as action', () => {
  assert.equal(detectOperationalContent('This policy does not apply, except where local law requires otherwise.'), undefined);
});

test('a right/entitlement statement is not classified as action', () => {
  assert.equal(detectOperationalContent('The Licensee may terminate this agreement with 30 days notice.'), undefined);
});

test('a conditional/rule-bearing statement is not classified as action merely because it contains an action verb', () => {
  assert.equal(detectOperationalContent('If the response status is 429, wait and retry.'), undefined);
  assert.equal(detectOperationalContent('Roll back if validation fails.'), undefined);
  assert.equal(detectOperationalContent('When the amount exceeds the threshold, escalate the case.'), undefined);
});

test('a declarative/narrative statement with an explicit subject is not classified as action', () => {
  assert.equal(detectOperationalContent('The system sends a notification.'), undefined);
  assert.equal(detectOperationalContent('This document outlines the operational procedures for the company.'), undefined);
  assert.equal(detectOperationalContent('The reconciliation tool manages data normalization.'), undefined);
});

test('a plain fact or descriptive statement is not classified as action', () => {
  assert.equal(detectOperationalContent('CRM (SaaS) manages policy booking and customer data.'), undefined);
  assert.equal(detectOperationalContent('Business is generated via direct sales and referral partners.'), undefined);
});

test('a bare fragment with no object/complement is not classified as action', () => {
  assert.equal(detectOperationalContent('Verify.'), undefined);
  assert.equal(detectOperationalContent('Install'), undefined);
});

test('a question is not classified as action', () => {
  assert.equal(detectOperationalContent('Which endpoint should be verified?'), undefined);
});

// --- Cross-domain coverage beyond the required list ---

test('cross-domain action detection: API documentation phrasing', () => {
  assert.equal(detectOperationalContent('Create a resource.'), 'action');
  assert.equal(detectOperationalContent('Handle a response.'), 'action');
  assert.equal(detectOperationalContent('Retry a failed request.'), 'action');
  assert.equal(detectOperationalContent('Authenticate before calling an endpoint.'), 'action');
});

test('cross-domain action detection: general handbook phrasing', () => {
  assert.equal(detectOperationalContent('Escalate unresolved cases.'), 'action');
  assert.equal(detectOperationalContent('Confirm the customer details.'), 'action');
  assert.equal(detectOperationalContent('Collect the required documents.'), 'action');
});

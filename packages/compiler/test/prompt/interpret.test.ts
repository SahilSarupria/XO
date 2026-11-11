import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretPrompt, stripIntentSentences } from '../../src/prompt/interpret.js';

// Domain-neutral wording throughout.

test('rule-shaped statements are separated from intents, with typed modality and outcome', () => {
  const r = interpretPrompt('If the widget count exceeds 5, approve the request. The operator must log each event.');
  assert.equal(r.statements.length, 2);
  const rule = r.statements.find((s) => /approve/.test(s.text))!;
  assert.equal(rule.kind, 'rule');
  assert.equal(rule.outcomeType, 'approve');
  assert.equal(rule.structurable, true);
  const obligation = r.statements.find((s) => /log each event/.test(s.text))!;
  assert.equal(obligation.modality, 'obligation');
  assert.equal(r.intents.length, 0);
});

test('a purpose statement is an intent split into requested behaviours, never a rule', () => {
  const r = interpretPrompt('Build a request handling system that checks forms, applies size limits and requests lead approval.');
  assert.equal(r.statements.length, 0);
  assert.equal(r.intents.length, 1);
  assert.deepEqual(r.intents[0]!.behaviours.map((b) => b.toLowerCase()), ['checks forms', 'applies size limits', 'requests lead approval']);
});

test('missing facts become targeted questions instead of invented values or connectors', () => {
  const r = interpretPrompt('Build a request handling system that checks forms, applies size limits, requests lead approval and emails the owner.');
  const reasons = r.questions.map((q) => q.reason).sort();
  assert.ok(reasons.includes('missing-criterion'), 'checks forms');
  assert.ok(reasons.includes('missing-threshold'), 'size limits');
  assert.ok(reasons.includes('missing-approver'), 'lead approval');
  assert.ok(reasons.includes('missing-target'), 'emails the owner');
  assert.equal(r.status, 'needs_clarification');
  // every question is anchored to the sentence that caused it
  for (const q of r.questions) assert.ok(q.about.length > 0 && q.question.endsWith('?'));
});

test('a stated number satisfies the threshold question', () => {
  const r = interpretPrompt('Build a system that applies a size limit of 10 units.');
  assert.equal(r.questions.some((q) => q.reason === 'missing-threshold'), false);
});

test('an unconditional approval is flagged for explicit confirmation, not silently accepted', () => {
  const r = interpretPrompt('Approve every request.');
  assert.ok(r.questions.some((q) => q.reason === 'unconditional-approval'));
});

test('a conditional rule whose condition cannot be structured gets a question; an unconditional obligation does not', () => {
  const unstructurable = interpretPrompt('If the gadget behaves oddly, the request must be rejected.');
  assert.ok(unstructurable.questions.some((q) => q.reason === 'unformalized-condition'));
  const plain = interpretPrompt('The operator must log each event.');
  assert.equal(plain.questions.some((q) => q.reason === 'unformalized-condition'), false);
});

test('bulleted and numbered lists are read line by line', () => {
  const r = interpretPrompt('- If the widget count exceeds 5, approve the request.\n- The operator must log each event.\n3. Staff must not open the panel.');
  assert.equal(r.statements.length, 3);
  assert.equal(r.statements[2]!.kind, 'prohibition');
});

test('status: ready when everything formalizes, no_actionable_content for chatter', () => {
  assert.equal(interpretPrompt('If the widget count exceeds 5, approve the request.').status, 'ready');
  assert.equal(interpretPrompt('Hello there, thanks for helping.').status, 'no_actionable_content');
  assert.equal(interpretPrompt('').status, 'no_actionable_content');
});

test('interpretation is deterministic and never mentions a connector it was not given', () => {
  const text = 'Build a system that emails the owner when the widget count exceeds 5.';
  assert.deepEqual(interpretPrompt(text), interpretPrompt(text));
  const json = JSON.stringify(interpretPrompt(text)).toLowerCase();
  for (const invented of ['gmail', 'smtp', 'slack', 'outlook']) assert.equal(json.includes(invented), false);
});

test('stripIntentSentences removes purpose statements but keeps rules, bullets and line structure', () => {
  const text = '# Spec\nBuild a system that emails the owner.\n- If the widget count exceeds 5, approve the request.\n- The operator must log each event. Build a thing that does stuff.';
  const out = stripIntentSentences(text);
  assert.equal(out.includes('emails the owner'), false);
  assert.equal(out.includes('Build a thing'), false);
  assert.ok(out.includes('- If the widget count exceeds 5, approve the request.'));
  assert.ok(out.includes('- The operator must log each event.'));
  assert.ok(out.startsWith('# Spec'));
});

test('stripIntentSentences leaves a prompt with no intents byte-identical', () => {
  const text = 'If the widget count exceeds 5, approve the request.\n\nThe operator must log each event.';
  assert.equal(stripIntentSentences(text), text);
});

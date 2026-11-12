import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcomeType } from '../../src/reasoning/outcome-type.js';

// Domain-neutral wording. Outcome type is derived ONLY from what the text says; nothing is inferred or invented.
const cases: readonly [string, string][] = [
  ['approve the request', 'approve'],
  ['the order may proceed', 'approve'],
  ['entry is permitted', 'approve'],
  ['the request is granted', 'approve'],
  ['the request must be rejected', 'deny'],
  ['entry must be denied', 'deny'],
  ['the application may be declined', 'deny'],
  ['the item is not covered', 'deny'],
  ['entry is not permitted', 'deny'],
  ['the unit must not proceed to the next stage', 'deny'],
  ['manager approval is required', 'requires_approval'],
  ['the purchase requires approval from the director', 'requires_approval'],
  ['the request must be approved by the lead', 'requires_approval'],
  ['department head approval is required', 'requires_approval'],
  ['escalate to the duty lead', 'escalate'],
  ['the case must be referred to the committee', 'escalate'],
  ['route the ticket to the second tier', 'escalate'],
  ['manager approval is not required', 'none'],
  ['the operator must log the event', 'none'],
  ['the supplier may suspend the service', 'none'],
  ['notify the engineering lead', 'none'],
  ['', 'none'],
];
for (const [text, expected] of cases) {
  test(`classifyOutcomeType: "${text}" -> ${expected}`, () => {
    assert.equal(classifyOutcomeType(text), expected);
  });
}

test('"approve" as a verb is an approve outcome, but "approval ... required" is a requires_approval outcome (not conflated)', () => {
  assert.equal(classifyOutcomeType('approve the entry'), 'approve');
  assert.equal(classifyOutcomeType('approval of the entry is required'), 'requires_approval');
});

test('a requirement for approval is never read as a denial or an approval', () => {
  assert.notEqual(classifyOutcomeType('director approval is required before release'), 'deny');
  assert.notEqual(classifyOutcomeType('director approval is required before release'), 'approve');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const MANUAL = `# Northwind Logistics — Expense Policy

## Rules

**E1 Receipts.** An expense over $25 is only reimbursable if a receipt is attached. If there is no receipt, the expense is rejected.

**E3 Meals.** Alcohol is never reimbursable.

**E5 Gifts.** A gift to a client worth more than $100 requires approval from the Compliance Office.

**E7 Large expenses.** Any expense above $5,000 needs Director approval; the desk escalates to the Director.
`;

test('authority-by-approval, evidence-required and never-allowed shapes are read generically', async () => {
  const r = await compileSources([{ kind: 'document', text: MANUAL, title: 'Expense', sourcePath: 'e.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const steps = r.value.policy!.program.steps.flatMap((s) => (s.kind === 'gate' ? [s.when] : []));
  assert.ok(steps.includes('expense_usd > 25 && receipt_attached == false'));
  assert.ok(steps.includes('alcohol == true'));
  assert.ok(steps.includes('gift_usd > 100'));
  assert.ok(steps.includes('expense_usd > 5000'));
  // the restating sentence ("If there is no receipt…") is understood, not left for review
  assert.equal(r.value.policy!.review.unrecognized.length, 0);
});

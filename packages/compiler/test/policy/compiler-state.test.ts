import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const corpus = (name: string): string => readFileSync(fileURLToPath(new URL(`../corpus/${name}`, import.meta.url)), 'utf8');
const compile = async (text: string) => {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'p.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value;
};

test('an UNFORMALIZED_RULE leaf declares it is a COMPILER state (unresolved), distinct from a policy escalation — decision value unchanged', async () => {
  const v = await compile(corpus('expense-approval.md'));
  assert.ok(v.policy?.trees && v.policy.trees.length > 0);
  const leaves = v.policy!.trees!.flatMap((t) => Object.values(t.nodes).filter((n) => n.type === 'leaf')) as { output: Record<string, unknown> }[];
  const unformalized = leaves.filter((l) => l.output['reason_code'] === 'UNFORMALIZED_RULE');
  assert.ok(unformalized.length >= 1);
  for (const l of unformalized) {
    assert.equal(l.output['decision'], 'escalate'); // existing contract preserved for downstream consumers
    assert.equal(l.output['compiler_state'], 'unresolved'); // the additive, typed distinction
  }
  const others = leaves.filter((l) => l.output['reason_code'] !== 'UNFORMALIZED_RULE');
  assert.ok(others.length >= 1);
  for (const l of others) assert.equal(l.output['compiler_state'], undefined); // genuine policy outcomes carry no compiler-state marker
});

test('the policy review is kept even when NO tree could be built, so unrecognised sentences are never discarded', async () => {
  const v = await compile('# Decision Rules\n7.1 If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.\n7.7 When the loss type is flood, the claim must be denied unless a flood endorsement is recorded.\n');
  assert.equal(v.policy, undefined);
  assert.ok(v.policyReview);
  assert.ok(v.policyReview!.unrecognized.length >= 1);
  assert.ok(v.diagnostics.some((d) => d.code === 'policy/no-tree-unrecognized' && /not recognised/.test(d.message)));
});

test('when a tree IS built the review is still exposed alongside it', async () => {
  const v = await compile(corpus('expense-approval.md'));
  assert.ok(v.policyReview);
  assert.equal(v.policyReview!.decisionSentences >= 1, true);
});

test('a document with no decision sentences at all has no review noise', async () => {
  const v = await compile('# Abstract\nThe study enrolled 240 participants across three sites.\n');
  assert.equal(v.diagnostics.some((d) => d.code === 'policy/no-tree-unrecognized'), false);
});

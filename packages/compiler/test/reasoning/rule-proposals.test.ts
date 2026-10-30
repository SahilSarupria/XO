import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeRules,
  validateProposal,
  confirmProposal,
  buildProposalPrompt,
  parseProposalResponse,
  modelProposer,
  type UnclassifiedSentence,
} from '../../src/reasoning/rule-proposals.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const item = (text: string): UnclassifiedSentence => ({
  text,
  cues: ['threshold'],
  sourceUnitId: 'u1',
  provenance: { documentPath: 'x' } as UnclassifiedSentence['provenance'],
});
const SENTENCE = 'A claim of more than 5000 needs the written approval of a claims manager.';

test('WS1-09: a grounded proposal in the runtime grammar is valid', () => {
  const p = validateProposal(item(SENTENCE), {
    condition: 'the claim amount exceeds 5000',
    outcome: 'needs the written approval of a claims manager',
  });
  assert.equal(p.status, 'valid');
  assert.deepEqual(p.reasons, []);
});

test('WS1-09: hallucinated numbers, ungrounded fields and outcomes, non-grammar conditions and exception clauses are each rejected with a reason', () => {
  const why = (sentence: string, condition: string, outcome: string) =>
    validateProposal(item(sentence), { condition, outcome }).reasons.join(' | ');
  assert.match(
    why(SENTENCE, 'the claim amount exceeds 9000', 'needs the written approval of a claims manager'),
    /number 9000 does not appear/,
  );
  assert.match(
    why(SENTENCE, 'the helicopter fuel exceeds 5000', 'needs the written approval of a claims manager'),
    /field .* not grounded/,
  );
  assert.match(why(SENTENCE, 'the claim amount exceeds 5000', 'wire the settlement offshore'), /outcome is not grounded/);
  assert.match(why(SENTENCE, 'the claim looks large', 'needs the written approval of a claims manager'), /not in the grammar/);
  assert.match(
    why(
      'A loss of more than 50000 must be reported to the reinsurer, except where the treaty says otherwise.',
      'the loss amount exceeds 50000',
      'must be reported to the reinsurer',
    ),
    /exception clause/,
  );
});

test('WS1-09: proposeRules survives a throwing or declining proposer and never aborts the batch', async () => {
  let n = 0;
  const out = await proposeRules([item(SENTENCE), item(SENTENCE), item(SENTENCE)], async () => {
    n += 1;
    if (n === 1) throw new Error('model unavailable');
    if (n === 2) return undefined;
    return { condition: 'the claim amount exceeds 5000', outcome: 'needs the written approval of a claims manager' };
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.status, 'valid');
});

test('WS1-09: confirmation needs a named reviewer and refuses a rejected proposal', () => {
  const ok = validateProposal(item(SENTENCE), {
    condition: 'the claim amount exceeds 5000',
    outcome: 'needs the written approval of a claims manager',
  });
  assert.throws(() => confirmProposal(ok, '  ', '2026-10-29T00:00:00Z'), /named reviewer/);
  const bad = validateProposal(item(SENTENCE), {
    condition: 'the claim amount exceeds 9000',
    outcome: 'needs the written approval of a claims manager',
  });
  assert.throws(() => confirmProposal(bad, 'reviewer@example.com', '2026-10-29T00:00:00Z'), /rejected proposal/);
  assert.equal(confirmProposal(ok, 'reviewer@example.com', '2026-10-29T00:00:00Z').confirmedBy, 'reviewer@example.com');
});

test('WS1-09: the model adapter builds a prompt that carries the sentence and tolerates chatty or malformed replies', async () => {
  assert.ok(buildProposalPrompt(item(SENTENCE)).includes(JSON.stringify(SENTENCE)));
  assert.equal(parseProposalResponse('{"rule": null}'), undefined);
  assert.equal(parseProposalResponse('no json here'), undefined);
  assert.equal(parseProposalResponse('{"rule": {"condition": 3, "outcome": "x"}}'), undefined);
  assert.deepEqual(parseProposalResponse('Sure! ```json\n{"rule": {"condition": "the a exceeds 1", "outcome": "do b"}}\n```'), {
    condition: 'the a exceeds 1',
    outcome: 'do b',
  });
  const out = await proposeRules(
    [item(SENTENCE)],
    modelProposer(
      async () => '{"rule": {"condition": "the claim amount exceeds 5000", "outcome": "needs the written approval of a claims manager"}}',
    ),
  );
  assert.equal(out[0]!.status, 'valid');
});

test('WS1-09: only a confirmed rule reaches the graph — unconfirmed review items stay review items', async () => {
  const text = `# Claims\n\n## Approvals\n\n${SENTENCE}`;
  const source = [{ kind: 'document' as const, text, sourcePath: 'a.md' }];
  const before = await compileSources(source);
  assert.ok(before.ok);
  assert.ok(
    before.value.unclassified.some((u) => u.text === SENTENCE),
    'sentence is on the review list',
  );
  assert.ok(!before.value.graph.allNodes().some((n) => JSON.stringify(n.properties).includes('exceeds 5000')));

  const proposal = validateProposal(item(SENTENCE), {
    condition: 'the claim amount exceeds 5000',
    outcome: 'needs the written approval of a claims manager',
  });
  const confirmed = confirmProposal(proposal, 'reviewer@example.com', '2026-10-29T00:00:00Z');
  const after = await compileSources(source, { confirmedRules: [confirmed] });
  assert.ok(after.ok);
  assert.ok(!after.value.unclassified.some((u) => u.text === SENTENCE), 'a confirmed sentence leaves the review list');
  const rule = after.value.graph.allNodes().find((n) => JSON.stringify(n.properties).includes('exceeds 5000'));
  assert.ok(rule, 'the confirmed rule is in the graph');
  assert.equal(rule.metadata.confidence, 0.75);
  assert.ok(
    after.value.graph
      .allNodes()
      .some((n) => n.kind === 'capability' && JSON.stringify(n.properties).includes('checked as: the claim amount exceeds 5000')),
    'the confirmed rule mints its own checkable capability',
  );
});

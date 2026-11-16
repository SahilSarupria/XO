// UW-1 trust boundary T1/T2 (specs/security/TRUST_BOUNDARY.md), corpus skeleton (UAC-17): on the compiler's rule-proposal path document
// text reaches the model only JSON-encoded and labelled untrusted, and a proposal that follows a payload instead of the sentence is
// rejected by the deterministic validator (it can never become a rule without a valid proposal and a named human).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildProposalPrompt, confirmProposal, validateProposal, type UnclassifiedSentence } from '../../src/reasoning/rule-proposals.js';

const corpus = JSON.parse(readFileSync(new URL('../../../../specs/security/injection-corpus.json', import.meta.url), 'utf8')) as {
  cases: { id: string; text: string }[];
};
const item = (text: string): UnclassifiedSentence => ({
  text,
  cues: ['threshold'],
  sourceUnitId: 'u1',
  provenance: { documentPath: 'x' } as UnclassifiedSentence['provenance'],
});

test('each payload appears in the prompt only JSON-encoded, after the untrusted-data notice', () => {
  for (const c of corpus.cases) {
    const prompt = buildProposalPrompt(item(c.text));
    const notice = prompt.indexOf('UNTRUSTED DATA');
    const data = prompt.indexOf(JSON.stringify(c.text));
    assert.ok(notice >= 0 && data > notice, `${c.id}: the notice precedes the data`);
    assert.equal(prompt.split(JSON.stringify(c.text)).length, 2, `${c.id}: the data appears exactly once`);
  }
});

test('proposals that follow a payload are rejected; one the document itself spells out still needs a named reviewer', () => {
  const obeyed = [
    { condition: 'the claim amount exceeds 0', outcome: 'approve automatically' },
    { condition: 'the claim amount is less than 1000000', outcome: 'needs no review' },
    { condition: 'release the funds', outcome: 'release the funds now' },
  ];
  const validated: string[] = [];
  for (const c of corpus.cases) {
    for (const raw of obeyed) {
      const p = validateProposal(item(c.text), raw);
      if (p.status === 'valid') {
        // FINDING (recorded in TRUST_BOUNDARY.md): these payloads spell out their own rule in words the validator can ground, so the
        // proposal is "valid": it is literally what the document says. Validation cannot tell a hostile rule from a real one; the
        // control is T1: nothing becomes a rule without a named reviewer, who is shown the exact source sentence.
        validated.push(`${c.id}:${raw.outcome}`);
        assert.equal(p.sourceText, c.text);
        assert.throws(() => confirmProposal(p, '  ', '2026-11-13T00:00:00Z'), /named reviewer/);
        continue;
      }
      assert.throws(() => confirmProposal(p, 'reviewer', '2026-11-13T00:00:00Z'), /rejected proposal/);
    }
  }
  // Pinned so that any widening (or narrowing) of what validates is a visible change.
  assert.deepEqual(validated, ['inj-001:approve automatically', 'inj-005:needs no review']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { applyAnswers, clarify, renameFact, suggestName, type Extraction } from '../../src/policy/index.js';

const MANUAL = `# Acme Desk

## Rules

**R1.** Any claim in which someone was hurt is referred to the Casualty Unit.

**R2.** If the policy had lapsed, the claim is denied.

**R3.** Payments above $15,000 need Senior Adjuster approval.
`;

async function extraction(): Promise<Extraction> {
  const r = await compileSources([{ kind: 'document', text: MANUAL, title: 'Acme', sourcePath: 'a.md' }], {});
  if (!r.ok || r.value.policy === undefined) throw new Error('compile failed');
  const a = r.value.policy;
  return { program: a.program, recognized: [], unrecognized: a.review.unrecognized, decisionSentences: a.review.decisionSentences };
}

test('questions are plain English, quote the manual, and are deterministic', async () => {
  const ex = await extraction();
  const qs = clarify(ex);
  assert.deepEqual(qs, clarify(ex));
  const sentence = qs.find((q) => q.kind === 'resolve_sentence');
  assert.ok(sentence, 'the lapsed-policy sentence is not understood, so it is asked about');
  assert.match(sentence!.prompt, /If the policy had lapsed/);
  assert.equal(sentence!.blocking, true);
  assert.ok(
    qs.some((q) => q.kind === 'rename_fact' && q.suggestion === 'claim'),
    'awkward extracted names get a shorter suggestion',
  );
  assert.ok(
    qs.some((q) => q.kind === 'no_outcome'),
    'a manual with no default outcome is asked what happens when no rule applies',
  );
});

test('answers are applied through the checks; bad answers are refused with reasons and stay open', async () => {
  const ex = await extraction();
  const qs = clarify(ex);
  const sentence = qs.find((q) => q.kind === 'resolve_sentence')!;
  const rename = qs.find((q) => q.kind === 'rename_fact' && q.subject === 'claim_in_which_someone_hurt')!;
  const bad = applyAnswers(ex, qs, [
    {
      questionId: sentence.id,
      value: 'rule',
      proposal: {
        quote: 'If the policy had lapsed, the claim is denied',
        facts: [{ name: 'policy_in_force', type: 'boolean', description: 'in force' }],
        step: { kind: 'gate', when: 'policy_in_force == false && days > 7', decision: 'deny', reason: 'LAPSED' },
      },
    },
    { questionId: rename.id, value: 'Not A Name' },
  ]);
  assert.equal(bad.refused.length, 2);
  assert.ok(bad.open.some((q) => q.id === sentence.id) && bad.open.some((q) => q.id === rename.id));

  const good = applyAnswers(ex, qs, [
    {
      questionId: sentence.id,
      value: 'rule',
      proposal: {
        quote: 'If the policy had lapsed, the claim is denied',
        facts: [{ name: 'policy_in_force', type: 'boolean', description: 'in force' }],
        step: { kind: 'gate', when: 'policy_in_force == false', decision: 'deny', reason: 'LAPSED' },
      },
    },
    { questionId: rename.id, value: 'injury_involved' },
    { questionId: qs.find((q) => q.kind === 'no_outcome')!.id, value: 'escalate' },
  ]);
  assert.equal(good.refused.length, 0);
  assert.ok(good.extraction.program.facts.some((f) => f.name === 'injury_involved'));
  assert.ok(good.extraction.program.steps.some((s) => s.kind === 'gate' && s.when === 'injury_involved == true'));
  assert.ok(!good.open.some((q) => q.kind === 'resolve_sentence'));
});

test('renameFact rewrites expressions but not string literals, and refuses collisions', async () => {
  const ex = await extraction();
  const p = renameFact(
    {
      ...ex.program,
      steps: [
        ...ex.program.steps,
        {
          id: 'x',
          order: 99,
          kind: 'gate',
          when: "claim_type == 'claim_type'",
          outcome: { decision: 'deny', reason: 'X' },
          note: '',
          source: { rule: '', section: '', sentence: '' },
          origin: 'operator',
        },
      ],
      facts: [...ex.program.facts, { name: 'claim_type', type: 'string', description: '' }],
    },
    'claim_type',
    'kind_of_claim',
  );
  assert.ok(p.steps.some((s) => s.kind === 'gate' && s.when === "kind_of_claim == 'claim_type'"));
  assert.equal(renameFact(ex.program, 'claim_in_which_someone_hurt', 'claim_in_which_someone_hurt'), ex.program);
  assert.equal(suggestName('policyholder_who_has_made_2_or'), 'policyholder');
});

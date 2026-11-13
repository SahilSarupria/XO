/**
 * UW-3c — reading what real documents say: instructions behind lead phrases, verbs only where English puts verbs,
 * questions that ask rather than rule, obligations stated about a subject, hedged predictions that are not rules, names
 * that close what they open, and code kept out of the experience.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { imperativeClause, isQuestion } from '../../src/semantic/directive.js';
import { inVerbPosition } from '../../src/capabilities/rule-based-extractor.js';
import { nameFromClause } from '../../src/capabilities/clause.js';
import { splitSentences } from '../../src/capabilities/sentence-split.js';
import { parseSentence } from '../../src/reasoning/rule-pattern-parser.js';

test('an instruction is found behind a lead clause, a lead phrase, a filler word or an adverb', () => {
  assert.equal(imperativeClause('When complete, paste the ship into an email.'), 'paste the ship into an email.');
  assert.equal(imperativeClause('Early in the project, spend time with current users.'), 'spend time with current users.');
  assert.equal(imperativeClause('Then regularly test with real people.'), 'test with real people.');
  assert.equal(imperativeClause('Re-read your diff.'), 'Re-read your diff.');
  assert.equal(imperativeClause('• Designate a captain.'), 'Designate a captain.');
  // Statements, labels and nouns are not instructions.
  assert.equal(imperativeClause('The team will review the plan.'), undefined);
  assert.equal(imperativeClause('Contact: the account manager'), undefined);
  assert.equal(imperativeClause('Break (5 minutes)'), undefined);
  assert.equal(imperativeClause('Name, role, start date'), undefined);
});

test('a bold run-in label and an emoji icon are not part of the instruction; a soft lead names the verb after its "to"', async () => {
  assert.equal(
    imperativeClause('**Onboardee and buddy:** Try to go through your checklists in order.'),
    'Try to go through your checklists in order.',
  );
  assert.equal(
    imperativeClause('\u260e\ufe0f Take a few minutes now to exchange contact details.'),
    'Take a few minutes now to exchange contact details.',
  );
  // A bold title that is a sentence, not a label, is left alone.
  assert.equal(imperativeClause('**Never commit secrets.** Keys stay in the vault.'), undefined);
  const md = [
    '# Onboarding',
    '',
    'Welcome.',
    '',
    '**Onboardee and buddy:** Try to go through your checklists in order.',
    '',
    '\u260e\ufe0f Take a few minutes now to exchange emergency contact information.',
    '',
    '**Buddy:** Review the access list.',
    '',
    'Take the bus to the office.',
    '',
    'Go Digit General Insurance Ltd is the insurer.',
  ].join('\n');
  const r = await compileSources([{ kind: 'document', text: md, sourcePath: 'onboarding.md' }], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  const names = r.value.graph
    .allNodes()
    .filter((n) => n.kind === 'capability')
    .map((n) => (n.properties as { name: string }).name)
    .sort();
  assert.deepEqual(names, [
    'Exchange emergency contact information',
    'Go through your checklists in order',
    'Review the access list',
    'Take the bus to the office',
  ]);
});

test('a question asks: it ends with a question mark, quotes and brackets allowed', () => {
  assert.equal(isQuestion('Who are your primary users?'), true);
  assert.equal(isQuestion('Ask: "What problem are we solving?"'), true);
  assert.equal(isQuestion('Answer the question.'), false);
});

test('a verb is a verb only in a verb position', () => {
  const at = (s: string, word: string): boolean => {
    const words = s.split(' ');
    return inVerbPosition(words, words.indexOf(word));
  };
  assert.equal(at('Wait and retry', 'retry'), true);
  assert.equal(at('Please review the plan', 'review'), true);
  assert.equal(at('You should notify the owner', 'notify'), true);
  assert.equal(at('Do not delete it; instead notify the owner', 'notify'), true);
  assert.equal(at('Case H: policy expired -> coverage review', 'review'), true);
  assert.equal(at('Update your emergency contact information', 'contact'), false);
  assert.equal(at('Keep your personal schedule current', 'schedule'), false);
});

test('a capability name closes every bracket and quote it opens', () => {
  for (const s of [
    'Review the (draft plan',
    'Open the "Team Charter template and fill it',
    'Submit the leave request (form SF-71) to your supervisor',
  ]) {
    const name = nameFromClause(s.split(' '), 0, s.split(' ')[0]!.toLowerCase()).name;
    assert.equal((name.match(/\(/g) ?? []).length, (name.match(/\)/g) ?? []).length, name);
    assert.equal((name.match(/"/g) ?? []).length % 2, 0, name);
  }
});

test('a blank line ends a sentence even without a full stop (a heading or a list label above prose)', () => {
  assert.deepEqual(
    splitSentences('Pick a buddy\n\nThe buddy answers questions.').map((s) => s.text),
    ['Pick a buddy', 'The buddy answers questions.'],
  );
});

test('obligations stated about a subject are policies; hedged predictions are not rules', () => {
  const kinds = (s: string): string[] => parseSentence(s).candidates.map((c) => `${c.nodeType}:${c.matchedPattern}`);
  assert.deepEqual(kinds('Each team member is responsible for reviewing their own code.'), ['policy:policy:subject-deontic']);
  assert.deepEqual(kinds('Agency staff are expected to complete the training within 30 days.'), ['policy:policy:subject-deontic']);
  assert.deepEqual(kinds('It is important to keep the repository public.'), ['policy:policy:importance-statement']);
  assert.deepEqual(kinds('Teams should ship weekly.'), ['policy:policy:subject-deontic']);
  assert.deepEqual(kinds('This will probably take two weeks.'), []);
  assert.deepEqual(kinds('The review may take several days.'), []);
});

test('end to end: steps keep their order, a nested note is a rule, code is not a step, questions are not rules, ticks are kept', async () => {
  const md = [
    '# Set up a repository',
    '',
    '## Steps',
    '',
    '1. Create the repository from the template.',
    '1. Clone it to your machine.',
    '   - Use SSH, not HTTPS.',
    '1. Run the tests:',
    '',
    '```sh',
    'npm install',
    'npm test',
    '```',
    '',
    '## Questions to ask',
    '',
    '- Who owns this repository?',
    '- What data does it hold?',
    '',
    '## Checklist',
    '',
    '- [ ] Enable branch protection',
    '- [x] Add a licence file',
    '',
    'Each team member is responsible for reviewing their own code.',
    'The first review will probably take a week.',
  ].join('\n');
  const r = await compileSources([{ kind: 'document', text: md, sourcePath: 'setup.md' }], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  const nodes = r.value.graph.allNodes();
  const steps = nodes
    .filter((n) => n.kind === 'capability')
    .map((n) => n.properties as { name: string; metadata: Record<string, string> })
    .sort((a, b) => Number(a.metadata['step.ordinal']) - Number(b.metadata['step.ordinal']))
    .map((p) => `${p.metadata['step.ordinal']} ${p.name}`);
  assert.deepEqual(steps, ['1 Create the repository', '2 Clone it to your machine', '3 Run the tests']);
  const rules = nodes
    .filter((n) => n.kind === 'constraint')
    .map((n) => {
      const p = n.properties as { rule: string; checkbox?: string };
      return `${n.metadata.subtype}${p.checkbox !== undefined ? `[${p.checkbox}]` : ''} ${p.rule}`;
    })
    .sort();
  assert.deepEqual(rules, [
    'acceptance_criterion[checked] Add a licence file',
    'acceptance_criterion[unchecked] Enable branch protection',
    'policy Each team member is responsible for reviewing their own code',
    'policy Use SSH, not HTTPS',
  ]);
});

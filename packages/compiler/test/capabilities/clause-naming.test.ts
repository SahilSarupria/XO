/**
 * UW-3b (B, E) — capability names from one clause, abbreviation-aware sentences, and confidence from text quality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFromClause, nameFromPassive } from '../../src/capabilities/clause.js';
import { splitSentences } from '../../src/capabilities/sentence-split.js';
import { assessCandidateQuality } from '../../src/capabilities/quality.js';
import { directiveOf, isImperative } from '../../src/semantic/directive.js';
import { RuleBasedCapabilityExtractor } from '../../src/capabilities/rule-based-extractor.js';
import type { ExperienceUnit, ExperienceUnitId } from '../../src/semantic/types.js';

const words = (s: string): string[] => s.split(' ').filter((w) => w.length > 0);
const name = (s: string, verb: string, at = 0): string => nameFromClause(words(s), at, verb).name;

test('the object stops at a comma that starts the next instruction', () => {
  assert.equal(name('Run existing tests, add new ones, and try edge cases.', 'run'), 'Run existing tests');
  assert.equal(name('Pull latest code, create a branch (e.g. feature/short-name), confirm it.', 'pull'), 'Pull latest code');
});

test('a comma-separated object list stays one object', () => {
  assert.equal(name('Check naming, errors, and docs.', 'check'), 'Check naming, errors, and docs');
  assert.equal(name('Note files, tools, and risks.', 'note'), 'Note files, tools, and risks');
});

test('a compound verb is one verb, and a second instruction after "and" is not part of the object', () => {
  assert.equal(name('Merge or deploy per team process.', 'merge'), 'Merge or deploy');
  assert.equal(name('Update docs and notify stakeholders.', 'update'), 'Update docs');
});

test('subordinate clauses, brackets and adjuncts end the object; a stated deadline is kept', () => {
  assert.equal(name('Record incoming payments (which typically include TDS deductions).', 'record'), 'Record incoming payments');
  assert.equal(name('Implement one subtask at a time.', 'implement'), 'Implement one subtask');
  assert.equal(name('Generate monthly MIS reports for IRDAI compliance, including:', 'generate'), 'Generate monthly MIS reports');
  assert.equal(
    name('Contact the claims department within 30 days of the loss.', 'contact'),
    'Contact the claims department within 30 days',
  );
  assert.equal(name('Wait for approval.', 'wait'), 'Wait for approval');
});

test('an abbreviation inside the object does not end it', () => {
  assert.equal(name('Match CRM records vs. Insurer statements.', 'match'), 'Match CRM records vs Insurer statements');
});

test('a passive names what is acted on', () => {
  const w = words('Sales invoices are created in Tally Prime based solely on CRM data.');
  assert.equal(nameFromPassive(w, 3, 'create')?.name, 'Create Sales invoices in Tally Prime');
  const v = words('When a claim is approved for settlement, the settlement amount must be recorded before payment authorization.');
  assert.equal(nameFromPassive(v, 12, 'record')?.name, 'Record the settlement amount');
});

test('a sentence-initial determiner moved behind the verb is lower-cased; a defined term keeps its case', () => {
  const w = words('The meaning of reasonable precautions is determined having regard to the circumstances.');
  assert.equal(nameFromPassive(w, 6, 'determine')?.name, 'Determine the meaning of reasonable precautions');
  const b = words('Business is generated via direct sales.');
  assert.equal(nameFromPassive(b, 2, 'generate')?.name, 'Generate Business');
});

test('sentences: e.g., i.e., Mr. and "No. 5" do not end a sentence; "etc. Then" does', () => {
  const texts = (t: string): string[] => splitSentences(t).map((s) => s.text);
  assert.deepEqual(texts('Create a branch (e.g. feature/short-name), confirm the project runs.'), [
    'Create a branch (e.g. feature/short-name), confirm the project runs.',
  ]);
  assert.deepEqual(texts('Ask Mr. Shah. Then file it.'), ['Ask Mr. Shah.', 'Then file it.']);
  assert.deepEqual(texts('See clause No. 5 for limits.'), ['See clause No. 5 for limits.']);
  assert.deepEqual(texts('Add files, tools, etc. Then review.'), ['Add files, tools, etc.', 'Then review.']);
  assert.deepEqual(texts('The rate is 3.5 percent. It applies.'), ['The rate is 3.5 percent.', 'It applies.']);
  assert.deepEqual(texts('Reconcile invoice amounts vs. receipt amounts.'), ['Reconcile invoice amounts vs. receipt amounts.']);
});

test('quality: a glued step label, a leaked row number and cross-column text lower confidence and flag a possible extraction error', () => {
  const w = words('6 Review Re-read your diff.');
  const clause = nameFromClause(w, 1, 'review');
  const q = assessCandidateQuality({
    prior: 0.6,
    sentence: '6 Review Re-read your diff.',
    words: w,
    verbIndex: 1,
    clause,
    layoutSuspect: false,
  });
  assert.deepEqual(q.flags, ['label-glued', 'leaked-marker']);
  assert.equal(q.possibleExtractionError, true);
  assert.ok(q.confidence < 0.25);
  const clean = assessCandidateQuality({
    prior: 0.6,
    sentence: 'Write the goal in one sentence.',
    words: words('Write the goal in one sentence.'),
    verbIndex: 0,
    clause: nameFromClause(words('Write the goal in one sentence.'), 0, 'write'),
    layoutSuspect: false,
  });
  assert.deepEqual(clean.flags, []);
  assert.equal(clean.confidence, 0.6);
  const garbled = assessCandidateQuality({
    ...{ prior: 0.45, sentence: '27 Contact No Email ID', words: words('27 Contact No Email ID'), verbIndex: 1 },
    clause: nameFromClause(words('27 Contact No Email ID'), 1, 'contact'),
    layoutSuspect: true,
  });
  assert.equal(garbled.reject, true, 'cross-column text with a leaked marker is not minted at all');
});

test('directives: negative imperatives are prohibitions, instructions obligations, "should" advisory', () => {
  assert.deepEqual(directiveOf('Never commit secrets.'), { modality: 'prohibition', polarity: 'negative' });
  assert.deepEqual(directiveOf('Do not mix unrelated changes.'), { modality: 'prohibition', polarity: 'negative' });
  assert.deepEqual(directiveOf('If the requirement is unclear, ask before writing code.'), {
    modality: 'obligation',
    polarity: 'positive',
  });
  assert.deepEqual(directiveOf('You should keep functions short.'), { modality: 'advisory', polarity: 'positive' });
  assert.equal(directiveOf('A second pair of eyes catches what you cannot see.')?.modality, 'prohibition');
  assert.equal(directiveOf('The Insured is a company.'), undefined);
  assert.equal(isImperative('Re-read your diff.'), true);
  assert.equal(isImperative('Policy Schedule'), false);
});

function unit(content: string, extra: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: 'eu_test' as ExperienceUnitId,
    title: 't',
    headingTitle: undefined,
    semanticType: 'general',
    content,
    provenance: { documentPath: 'd', pages: [1], sectionPath: [], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 0, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
    ...extra,
  };
}

test('the extractor: no "<Verb> Action" placeholder, no noun read as a verb, intransitive instructions kept', async () => {
  const extractor = new RuleBasedCapabilityExtractor();
  const names = async (text: string, extra: Partial<ExperienceUnit> = {}): Promise<string[]> => {
    const r = await extractor.extract(unit(text, extra), { nodes: [], edges: [] });
    assert.ok(r.ok);
    return r.value.capabilities.map((c) => c.name);
  };
  assert.deepEqual(await names('Policy Schedule'), []);
  assert.deepEqual(await names('A deductible applies unless the Schedule specifies a higher deductible.'), []);
  assert.deepEqual(await names('If the response status is 429, wait and retry.'), ['Retry']);
  assert.deepEqual(await names('Run existing tests, add new ones, and try edge cases.'), ['Run existing tests']);
  assert.deepEqual(
    await names('If the Policy is active, the property is scheduled, and the loss is not excluded, the claim proceeds.'),
    [],
  );
  const flagged = await extractor.extract(unit('Contact the broker today.', { layoutSuspect: true }), { nodes: [], edges: [] });
  assert.ok(flagged.ok);
  assert.equal(flagged.value.capabilities[0]?.metadata['quality.review'], 'possible-extraction-error');
});

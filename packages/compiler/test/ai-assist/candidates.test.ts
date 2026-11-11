import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCandidatesToPromptSources, runCandidateProvider, validateCandidate, type CandidateProvider, type SemanticCandidate } from '../../src/ai-assist/candidates.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

// Domain-neutral wording. The model's output is a CANDIDATE: it must survive deterministic validation against the source.
const S = 'If the widget count exceeds 5 and the gadget is approved, the request must be rejected unless the lead agrees.';
const good = (over: Partial<SemanticCandidate> = {}): SemanticCandidate => ({
  sentence: S, condition: 'the widget count exceeds 5 and the gadget is approved', outcome: 'the request must be rejected', exceptions: ['the lead agrees'],
  modality: 'obligation', outcomeType: 'deny', evidence: 'the request must be rejected unless the lead agrees', ...over,
});

test('a faithful candidate is validated and its condition is structured by the DETERMINISTIC grammar, not trusted from the model', () => {
  const v = validateCandidate(good(), S);
  assert.equal(v.status, 'validated', v.reasons.join('; '));
  assert.equal(v.structured?.type, 'and');
  assert.deepEqual(v.reasons, []);
});

test('text that is not verbatim in the sentence is rejected (no paraphrase, no invented clause)', () => {
  assert.equal(validateCandidate(good({ condition: 'the widget count is more than five' }), S).status, 'rejected');
  assert.equal(validateCandidate(good({ outcome: 'the request is always declined' }), S).status, 'rejected');
  assert.equal(validateCandidate(good({ exceptions: ['the manager is on holiday'] }), S).status, 'rejected');
});

test('an invented number is rejected even inside otherwise verbatim-looking text', () => {
  const r = validateCandidate(good({ condition: 'the widget count exceeds 50 and the gadget is approved' }), S);
  assert.equal(r.status, 'rejected');
});

test('the model cannot flip modality, polarity or outcome type', () => {
  assert.equal(validateCandidate(good({ modality: 'permission' }), S).status, 'rejected');
  assert.equal(validateCandidate(good({ polarity: 'negative' }), S).status, 'rejected');
  assert.equal(validateCandidate(good({ outcomeType: 'approve' }), S).status, 'rejected');
});

test('it cannot claim an outcome the text does not state', () => {
  const sentence = 'If the widget count exceeds 5, the operator must log the event.';
  const r = validateCandidate({ sentence, condition: 'the widget count exceeds 5', outcome: 'the operator must log the event', outcomeType: 'approve', evidence: 'the operator must log the event' }, sentence);
  assert.equal(r.status, 'rejected');
  assert.ok(r.reasons.some((x) => /outcome/i.test(x)));
});

test('a verbatim span that DROPS a preceding negation or exception cue is rejected (truncation cannot flip meaning)', () => {
  const sentence = 'The request must not proceed unless the lead agrees.';
  const dropsNot = validateCandidate({ sentence, outcome: 'proceed', evidence: 'must not proceed' }, sentence);
  assert.equal(dropsNot.status, 'rejected');
  assert.ok(dropsNot.reasons.some((x) => /negation|exception/i.test(x)));
  const exceptionAsCondition = validateCandidate({ sentence, condition: 'the lead agrees', outcome: 'The request must not proceed', evidence: 'unless the lead agrees' }, sentence);
  assert.equal(exceptionAsCondition.status, 'rejected');
});

test('the evidence quote must exist in the sentence and the candidate must refer to the sentence it was asked about', () => {
  assert.equal(validateCandidate(good({ evidence: 'the policy explicitly allows this' }), S).status, 'rejected');
  assert.equal(validateCandidate(good({ sentence: 'A different sentence entirely.' }), S).status, 'rejected');
});

test('a verbatim condition the grammar cannot structure is validated but flagged, never presented as structured', () => {
  const sentence = 'If the gadget behaves oddly, the request must be rejected.';
  const v = validateCandidate({ sentence, condition: 'the gadget behaves oddly', outcome: 'the request must be rejected', evidence: 'the gadget behaves oddly' }, sentence);
  assert.equal(v.status, 'validated');
  assert.equal(v.structured, undefined);
  assert.ok(v.flags.includes('unstructured-condition'));
});

test('a domain lexicon lets the deterministic grammar structure a domain word the model quoted', () => {
  const sentence = 'If the sample is quarantined, the operator must log the event.';
  const c: SemanticCandidate = { sentence, condition: 'the sample is quarantined', outcome: 'the operator must log the event', evidence: 'the sample is quarantined' };
  assert.equal(validateCandidate(c, sentence).structured, undefined);
  assert.equal(validateCandidate(c, sentence, { categoricalStates: ['quarantined'] }).structured?.type, 'categorical');
});

test('a throwing or malformed provider is isolated: the run records the error and never propagates it', async () => {
  const boom: CandidateProvider = { propose: async () => { throw new Error('rate limited'); } };
  const r = await runCandidateProvider(boom, [{ sentence: S }]);
  assert.equal(r[0]!.error, 'rate limited');
  assert.deepEqual(r[0]!.results, []);
  const junk: CandidateProvider = { propose: async () => [null as never, { nonsense: true } as never] };
  const j = await runCandidateProvider(junk, [{ sentence: S }]);
  assert.ok(j[0]!.results.every((x) => x.validation.status === 'rejected'));
});

test('only validated candidates convert to a prompt source, and it still requires a human confirmation to compile', async () => {
  const provider: CandidateProvider = { propose: async () => [good(), good({ outcome: 'the request is always declined' })] };
  const runs = await runCandidateProvider(provider, [{ sentence: S }]);
  const sources = acceptedCandidatesToPromptSources(runs, 'reviewer@example.test');
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.kind, 'prompt');
  assert.equal(sources[0]!.confirmedBy, 'reviewer@example.test');
  assert.equal(acceptedCandidatesToPromptSources(runs, '   ').every((s) => s.confirmedBy === undefined), true); // unconfirmed unless someone confirms
  const r = await compileSources(sources, {});
  assert.equal(r.ok, true);
});

test('compile with a candidateProvider reports validated candidates for unresolved/lost sentences and changes NOTHING in the graph', async () => {
  const text = '# Rules\nIf the gadget behaves oddly, the request must be rejected.\nIf the widget count exceeds 5, the operator must log the event.\n';
  const provider: CandidateProvider = {
    propose: async ({ sentence }) => [{ sentence, condition: 'the gadget behaves oddly', outcome: 'the request must be rejected', evidence: 'the gadget behaves oddly' }],
  };
  const withAi = await compileSources([{ kind: 'document', text, sourcePath: 'r.md' }], { candidateProvider: provider });
  const without = await compileSources([{ kind: 'document', text, sourcePath: 'r.md' }], {});
  assert.equal(withAi.ok && without.ok, true);
  if (!withAi.ok || !without.ok) return;
  assert.ok(withAi.value.aiCandidates && withAi.value.aiCandidates.length >= 1);
  assert.equal(without.value.aiCandidates, undefined);
  assert.deepEqual(withAi.value.stats, without.value.stats);
  assert.deepEqual(withAi.value.executionReadiness, without.value.executionReadiness);
});

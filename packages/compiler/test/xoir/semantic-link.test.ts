import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLink, scoreStructuralLink, isStrictSectionPathPrefix, significantTokens } from '../../src/xoir/semantic-link.js';

// --- significantTokens -------------------------------------------------------

test('drops stopwords and short fragments, keeps meaningful content words', () => {
  const tokens = significantTokens('The insurer will process the claim within 14 days');
  assert.ok(tokens.has('insurer'));
  assert.ok(tokens.has('process'));
  assert.ok(tokens.has('claim'));
  assert.ok(tokens.has('14'));
  assert.ok(tokens.has('day')); // "days" -> stemmed to "day"
  assert.ok(!tokens.has('the'));
  assert.ok(!tokens.has('will'));
  assert.ok(!tokens.has('within'));
});

test('light stemming unifies plural/verb-form variants with their base form', () => {
  assert.ok(significantTokens('claims').has('claim'));
  assert.ok(significantTokens('claimed').has('claim'));
  assert.ok(significantTokens('processing').has('process'));
  assert.ok(significantTokens('rejected').has('reject'));
});

test('a purely numeric token is preserved verbatim, never stemmed away', () => {
  assert.ok(significantTokens('the amount is 5000').has('5000'));
});

test('does not conflate two different numbers via stemming', () => {
  const a = significantTokens('exceeds 5000');
  const b = significantTokens('exceeds 10000');
  assert.ok(!a.has('10000'));
  assert.ok(!b.has('5000'));
});

// --- scoreLink: exact_label tier --------------------------------------------

test('exact label match scores high confidence regardless of unit', () => {
  const score = scoreLink('If the claim assessment amount exceeds 5000, then reject the claim.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-b' });
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'exact_label');
  assert.equal(score!.confidence.basis, 'observed');
  assert.ok(score!.confidence.score >= 0.85);
});

test('exact label match is case- and whitespace-insensitive', () => {
  const score = scoreLink('the CLAIM   ASSESSMENT threshold is met', undefined, { label: 'Claim Assessment', experienceUnitId: undefined });
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'exact_label');
});

// --- scoreLink: same_unit_term_overlap tier ---------------------------------

test('same unit + shared term links at moderate/inferred confidence when no exact match exists', () => {
  const score = scoreLink('If the amount claimed exceeds 5000, then reject the claim.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a' });
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.equal(score!.confidence.basis, 'inferred');
  assert.ok(score!.confidence.score < 0.85, 'must stay well below the exact-match tier\'s score');
  assert.deepEqual(score!.evidence.sharedTerms, ['claim']);
});

test('same unit alone, with zero shared vocabulary, is NOT sufficient evidence', () => {
  const score = scoreLink('The building has three floors and a basement.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a' });
  assert.equal(score, undefined);
});

test('shared vocabulary alone, in a DIFFERENT unit, is NOT sufficient evidence (no false same-document link)', () => {
  const score = scoreLink('Claims above 5000 may be rejected.', 'unit-b', { label: 'Claim Assessment', experienceUnitId: 'unit-a' });
  assert.equal(score, undefined);
});

test('unrelated capability and rule in the same document must not link merely by co-occurring', () => {
  const score = scoreLink('Claims above 5000 may be rejected.', 'unit-elsewhere', { label: 'Contact 24-Hour Call Centre', experienceUnitId: 'unit-callcentre' });
  assert.equal(score, undefined);
});

test('similar-looking labels ("Policy" / "Policy Copy" / "Policy Schedule" / "Policy Number") are not conflated with each other by generic overlap alone', () => {
  // "Policy Copy" legitimately exact-matches text that literally contains it — that's correct, unchanged exact-match behavior.
  const exact = scoreLink('Please retain your Policy Copy for your records.', 'unit-x', { label: 'Policy Copy', experienceUnitId: 'unit-y' });
  assert.ok(exact);
  assert.equal(exact!.evidence.kind, 'exact_label');

  // But the OTHER distinct "Policy ..." labels must not cross-match that same text just because they share the generic word "Policy" — no exact substring, and (different unit) no overlap tier either.
  for (const label of ['Policy Schedule', 'Policy Number']) {
    const score = scoreLink('Please retain your Policy Copy for your records.', 'unit-x', { label, experienceUnitId: 'unit-y' });
    assert.equal(score, undefined, `"${label}" must not link to "Policy Copy" text on the shared generic word "Policy" alone`);
  }
});

test('undefined experienceUnitId on either side never satisfies the same-unit tier', () => {
  const score = scoreLink('the claim amount was processed', undefined, { label: 'Claim Assessment', experienceUnitId: undefined });
  assert.equal(score, undefined);
});

test('an empty or whitespace-only label never produces a link', () => {
  assert.equal(scoreLink('anything at all', 'u', { label: '', experienceUnitId: 'u' }), undefined);
  assert.equal(scoreLink('anything at all', 'u', { label: '   ', experienceUnitId: 'u' }), undefined);
});

// --- scoreLink: LinkCandidate.sameUnitText ----------------------------------

test('sameUnitText, when provided, is used for same-unit overlap scoring instead of the bare label', () => {
  // "Review Action" alone shares nothing with the rule text below.
  const withoutSameUnitText = scoreLink('manager approval is required before the claim is settled', 'unit-a', { label: 'Review Action', experienceUnitId: 'unit-a' });
  assert.equal(withoutSameUnitText, undefined);

  // But its description (the full originating sentence) does share "claim".
  const withSameUnitText = scoreLink('manager approval is required before the claim is settled', 'unit-a', {
    label: 'Review Action',
    experienceUnitId: 'unit-a',
    sameUnitText: 'Review Action the claim must be referred for coverage review',
  });
  assert.ok(withSameUnitText);
  assert.equal(withSameUnitText!.evidence.kind, 'same_unit_term_overlap');
  assert.ok(withSameUnitText!.evidence.sharedTerms!.includes('claim'));
});

test('sameUnitText never affects exact_label matching — that tier still checks the bare label only', () => {
  // The label "Review" would exact-match this text on its own, but is deliberately short of MIN_REFERENCE_LABEL_LENGTH-style
  // callers' own filtering; here we only need to prove exact_label ignores sameUnitText content entirely.
  const score = scoreLink('a full review of the file was conducted', 'unit-a', {
    label: 'zzz-not-present-anywhere',
    experienceUnitId: 'unit-a',
    sameUnitText: 'review',
  });
  // sameUnitText alone contains "review" which IS present in reasoningText, so this must still resolve via the
  // same-unit-overlap tier (not exact_label, since the actual `label` "zzz-not-present-anywhere" never matches).
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
});

test('an empty sameUnitText falls back to producing no same-unit evidence when label is also otherwise non-overlapping', () => {
  const score = scoreLink('the building has three floors', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a', sameUnitText: '   ' });
  assert.equal(score, undefined);
});

test('omitting sameUnitText entirely preserves prior behavior exactly (falls back to label)', () => {
  const withField = scoreLink('If the amount claimed exceeds 5000, then reject the claim.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a' });
  const withUndefinedField = scoreLink('If the amount claimed exceeds 5000, then reject the claim.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a', sameUnitText: undefined });
  assert.deepEqual(withField, withUndefinedField);
});

test('confidence score scales mildly with shared-term count but stays capped below exact-match tier', () => {
  const oneShared = scoreLink('the claim was noted here', 'u', { label: 'Claim Review', experienceUnitId: 'u' });
  const threeShared = scoreLink('a review of the claim was processed here', 'u', { label: 'Claim Review Process', experienceUnitId: 'u' });
  assert.ok(oneShared && threeShared);
  assert.equal(oneShared!.evidence.kind, 'same_unit_term_overlap');
  assert.equal(threeShared!.evidence.kind, 'same_unit_term_overlap');
  assert.ok(threeShared!.confidence.score > oneShared!.confidence.score);
  assert.ok(threeShared!.confidence.score < 0.85);
});

// --- scoreLink: numeric-only same-unit evidence is insufficient (Problem B) -

test('a single isolated numeric token shared between two same-unit texts does NOT create a link', () => {
  // Mirrors the real fixture's actual false-positive shape: a "7. Decision
  // Rules" section heading and an unrelated "7.6 ..." sub-clause elsewhere
  // in the same unit share only the digit "7" — pure clause-numbering
  // coincidence, no real vocabulary in common.
  const score = scoreLink('7. Decision Rules. If the claim amount exceeds the limit, manager approval is required.', 'unit-a', {
    label: 'Schedule Action',
    experienceUnitId: 'unit-a',
    sameUnitText: '7.6 If the policy has expired, the item must be referred.',
  });
  assert.equal(score, undefined, 'a bare shared digit must never be sufficient same-unit evidence on its own');
});

test('multiple isolated numeric tokens shared between two same-unit texts still do NOT create a link', () => {
  const score = scoreLink('1. Definitions. 1.1 Insured Property means buildings and machinery. 1.2 Claim means a written demand.', 'unit-a', {
    label: 'Schedule Action',
    experienceUnitId: 'unit-a',
    sameUnitText: '1.4 Excess figure appears in the attached Annexure document.',
  });
  // Shares "1" (from "1.1"/"1.2" vs "1.4") — still purely numeric, still insufficient, even though more than one number-shaped fragment is present. No real word is shared on purpose, to isolate the numeric-only case.
  assert.equal(score, undefined);
});

test('a numeric token PLUS a real shared word still links — numeric evidence corroborates, it is only insufficient alone', () => {
  const score = scoreLink('3. Deductibles and Limits. 3.1 A deductible of INR 25,000 applies to each occurrence unless the Annexure states a higher figure.', 'unit-a', {
    label: 'Higher Deductible Handling',
    experienceUnitId: 'unit-a',
    sameUnitText: '3.1 A deductible of INR 25,000 applies to each covered occurrence unless the Annexure states a higher figure.',
  });
  assert.ok(score, 'shared "deductible" alongside the shared digit "3" is sufficient evidence');
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.ok(score!.evidence.sharedTerms!.includes('deductible'));
  // The numeric token is still reported — it's excluded only from the
  // *sufficiency* decision, never stripped from the evidence itself.
  assert.ok(score!.evidence.sharedTerms!.includes('3'));
});

test('a genuinely specific, meaningful shared number (not clause numbering) still corroborates a link once real vocabulary is also shared', () => {
  const score = scoreLink('a report must be filed within 30 days of the date of loss', 'unit-a', {
    label: 'Filing Deadline',
    experienceUnitId: 'unit-a',
    sameUnitText: 'reports are required within 30 days',
  });
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.deepEqual([...score!.evidence.sharedTerms!].sort(), ['30', 'day', 'report']);
});

test('meaningful textual overlap with no numeric tokens at all is entirely unaffected by the numeric-sufficiency rule', () => {
  const score = scoreLink('If the amount claimed exceeds 5000, then reject the claim.', 'unit-a', { label: 'Claim Assessment', experienceUnitId: 'unit-a' });
  assert.ok(score);
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.deepEqual(score!.evidence.sharedTerms, ['claim']);
});

// --- scoreLink: candidate-pool ambiguity for a single shared textual term (Problem B.1) -

test('a single shared textual term is rejected as evidence when the term appears in 2+ candidate nodes (ambiguous)', () => {
  const frequency = new Map([['claim', 6]]); // shared by 6 different candidates in the pool
  const score = scoreLink('any information provided in the claim is materially incorrect', 'unit-a', { label: '6. Claims Procedure', experienceUnitId: 'unit-a' }, frequency);
  assert.equal(score, undefined, 'a term shared by several candidates cannot, alone, tell you which one is meant');
});

test('a single shared textual term is accepted as evidence when the term appears in exactly 1 candidate node (candidate-unique)', () => {
  const frequency = new Map([['claim', 1]]); // this is the only candidate mentioning "claim"
  const score = scoreLink('any information provided in the claim is materially incorrect', 'unit-a', { label: '6. Claims Procedure', experienceUnitId: 'unit-a' }, frequency);
  assert.ok(score, 'a candidate-unique term is exactly as trustworthy as before — nothing else could have matched it');
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.deepEqual(score!.evidence.sharedTerms, ['claim']);
});

test('a single shared textual term with NO frequency data supplied at all (default empty map) is treated as unique — preserves prior behavior for callers that do not opt in', () => {
  const score = scoreLink('any information provided in the claim is materially incorrect', 'unit-a', { label: '6. Claims Procedure', experienceUnitId: 'unit-a' });
  assert.ok(score, 'omitting candidateTermFrequency entirely must behave exactly as it did before this feature existed');
  assert.deepEqual(score!.evidence.sharedTerms, ['claim']);
});

test('two or more shared textual terms remain sufficient evidence even when EVERY individual term is itself ambiguous (shared by many candidates)', () => {
  // Mirrors the real fixture's actual "insurer" + "loss" pair: both
  // terms individually common (shared by 7 and 6 candidates
  // respectively), but their co-occurrence is not subject to the
  // single-term ambiguity check at all.
  const frequency = new Map([
    ['insurer', 7],
    ['loss', 6],
  ]);
  const score = scoreLink('please advise the insurer as soon as any loss occurs', 'unit-a', { label: 'Insurer Loss Advisory Procedure', experienceUnitId: 'unit-a' }, frequency);
  assert.ok(score, 'multi-term overlap remains sufficient regardless of each term\'s own frequency');
  assert.equal(score!.evidence.kind, 'same_unit_term_overlap');
  assert.deepEqual([...score!.evidence.sharedTerms!].sort(), ['insurer', 'loss']);
});

test('a numeric token plus one ambiguous textual token still links — the pair counts as 2+ shared terms, exempt from the single-term ambiguity check', () => {
  const frequency = new Map([['deductible', 5]]); // shared by 5 different candidates — would fail the single-term check alone
  const score = scoreLink('3.1 A deductible of INR 25,000 applies to each occurrence', 'unit-a', {
    label: 'Deductible Clause',
    experienceUnitId: 'unit-a',
    sameUnitText: '3.2 A deductible of INR 50,000 applies to each occurrence',
  }, frequency);
  assert.ok(score, 'shared "3" plus shared "deductible" is a 2-term match, not subject to the single-term ambiguity gate');
  assert.ok(score!.evidence.sharedTerms!.includes('3'));
  assert.ok(score!.evidence.sharedTerms!.includes('deductible'));
});

test('an ambiguous single textual term stays rejected even when it is ALSO numeric-adjacent noise — the numeric-only rule and the ambiguity rule compose correctly', () => {
  // Sanity check that the two Problem B / B.1 gates don't interfere:
  // a lone numeric token is rejected by the (unchanged) numeric rule
  // regardless of any frequency data.
  const frequency = new Map([['7', 40]]);
  const score = scoreLink('7. Decision Rules', 'unit-a', { label: 'Schedule Action', experienceUnitId: 'unit-a', sameUnitText: '7.6 Some unrelated sub-clause' }, frequency);
  assert.equal(score, undefined);
});

// --- scoreStructuralLink: structural containment + lexical corroboration (Problem C) -

test('structural acceptance: a reasoning node nested inside a capability\'s section links, with meaningful lexical overlap', () => {
  const score = scoreStructuralLink('If the amount is below the minimum threshold, reject the charge.', ['Root', 'Create a Charge', 'Response'], {
    sectionPath: ['Root', 'Create a Charge'],
    lexicalText: 'Create a Charge Creates a new charge for the requested amount.',
  });
  assert.ok(score, 'structurally nested AND sharing "charge"/"amount" must link');
  assert.equal(score!.evidence.kind, 'structural_containment');
  assert.ok(score!.evidence.sharedTerms!.some((t) => t === 'charge' || t === 'amount'));
});

test('structural acceptance records the correct ancestor depth gap', () => {
  const score = scoreStructuralLink('reject the charge', ['Root', 'Create a Charge', 'Response', 'Errors'], {
    sectionPath: ['Root', 'Create a Charge'],
    lexicalText: 'Create a Charge for the requested amount',
  });
  assert.ok(score);
  assert.equal(score!.evidence.ancestorDepthGap, 2); // 4 - 2
});

test('same-unit behavior is unaffected: identical sectionPath (same section, not a descendant) is rejected by scoreStructuralLink', () => {
  // scoreStructuralLink is a STRICT-descendant-only check — same-unit
  // pairs are exact_label/same_unit_term_overlap's job, never this
  // function's, even when lexical overlap would otherwise be strong.
  const score = scoreStructuralLink('the charge amount', ['Root', 'Create a Charge'], {
    sectionPath: ['Root', 'Create a Charge'],
    lexicalText: 'Create a Charge for the requested amount',
  });
  assert.equal(score, undefined);
});

test('root exclusion: a capability whose sectionPath is document-root-level (length 1) never structurally governs anything, even with strong lexical overlap', () => {
  const score = scoreStructuralLink('the charge amount must be validated before capture', ['Payments API Reference', 'Create a Charge', 'Response'], {
    sectionPath: ['Payments API Reference'],
    lexicalText: 'Payments API Reference charge amount capture validated',
  });
  assert.equal(score, undefined, 'a document-title-level capability must never be a valid structural governing ancestor');
});

test('root exclusion also applies to an entirely empty sectionPath', () => {
  const score = scoreStructuralLink('the charge amount', ['Root', 'Create a Charge'], { sectionPath: [], lexicalText: 'charge amount' });
  assert.equal(score, undefined);
});

test('numeric-only rejection: a structural candidate whose only lexical overlap is numeric is not accepted', () => {
  const score = scoreStructuralLink('7.6 Some unrelated sub-clause', ['Root', 'Decision Rules', 'Sub-clause'], {
    sectionPath: ['Root', 'Decision Rules'],
    lexicalText: '7. Decision Rules',
  });
  assert.equal(score, undefined, 'a bare shared digit ("7") must not establish structural corroboration, mirroring Problem B\'s numeric-only rule');
});

test('no lexical corroboration: a structurally descendant reasoning node with zero shared vocabulary does not link', () => {
  const score = scoreStructuralLink('the disinfectant must be applied for at least sixty seconds', ['Root', 'Create a Charge', 'Response'], {
    sectionPath: ['Root', 'Create a Charge'],
    lexicalText: 'Create a Charge for the requested amount',
  });
  assert.equal(score, undefined);
});

test('sibling isolation: a reasoning node under one branch is not a structural descendant of an unrelated sibling capability, regardless of shared vocabulary', () => {
  // isStrictSectionPathPrefix itself must reject this — "Root" alone is
  // shared, but "Capability B"'s sectionPath is not a prefix of the
  // reasoning node's path at all.
  const score = scoreStructuralLink('the charge amount for this refund', ['Root', 'Capability A', 'Response'], {
    sectionPath: ['Root', 'Capability B'],
    lexicalText: 'Capability B charge amount refund',
  });
  assert.equal(score, undefined);
});

test('nearest-ancestor primitive: isStrictSectionPathPrefix correctly distinguishes a closer nested capability from a farther one', () => {
  const parent = ['Root', 'Parent Capability'];
  const child = ['Root', 'Parent Capability', 'Child Capability'];
  const reasoningPath = ['Root', 'Parent Capability', 'Child Capability', 'Details'];
  assert.equal(isStrictSectionPathPrefix(parent, reasoningPath), true);
  assert.equal(isStrictSectionPathPrefix(child, reasoningPath), true);
  // Both qualify structurally — rule-capability-linking.ts's job (not
  // this pure function's) is to prefer the longer/deeper one; this test
  // only proves both are correctly recognized as valid structural
  // ancestors, which is the precondition that selection logic depends on.
  assert.ok(child.length > parent.length);
});

test('confidence: structural_containment confidence is fixed and strictly below same_unit_term_overlap\'s floor', () => {
  const structural = scoreStructuralLink('the charge amount', ['Root', 'Create a Charge', 'Response'], { sectionPath: ['Root', 'Create a Charge'], lexicalText: 'Create a Charge for the requested amount' });
  const sameUnit = scoreLink('the charge amount', 'unit-a', { label: 'Create a Charge', experienceUnitId: 'unit-a', sameUnitText: 'Create a Charge for the requested amount' });
  assert.ok(structural && sameUnit);
  assert.ok(structural!.confidence.score < sameUnit!.confidence.score);
  assert.equal(structural!.confidence.score, 0.4);
});

test('B.1 interaction: structural_containment never consults candidate-pool term frequency — a term that would be B.1-ambiguous in the same-unit tier still corroborates structurally', () => {
  // scoreStructuralLink takes no frequency map parameter at all — this
  // test proves a term that WOULD fail B.1's ambiguity gate in scoreLink
  // (frequency >= 2) is still accepted here, confirming the two tiers
  // are genuinely independent, not that one silently defers to the other.
  const ambiguousFrequency = new Map([['claim', 6]]);
  const sameUnitResult = scoreLink('the claim was processed', 'unit-a', { label: 'Claims Procedure', experienceUnitId: 'unit-a' }, ambiguousFrequency);
  assert.equal(sameUnitResult, undefined, 'sanity: this term is indeed B.1-ambiguous in the same-unit tier');

  const structuralResult = scoreStructuralLink('the claim was processed incorrectly', ['Root', 'Claims Procedure', 'Errors'], {
    sectionPath: ['Root', 'Claims Procedure'],
    lexicalText: 'Claims Procedure for processing a claim',
  });
  assert.ok(structuralResult, 'structural_containment has no candidate-frequency concept at all — B.1 governs a different tier');
});

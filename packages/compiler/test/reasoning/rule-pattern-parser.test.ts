import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSentence } from '../../src/reasoning/rule-pattern-parser.js';

test('simple IF -> THEN rule', () => {
  const result = parseSentence('If the payment is late, apply a penalty fee.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'rule');
  assert.equal(c.condition, 'the payment is late');
  assert.equal(c.action, 'apply a penalty fee');
});

test('WHEN -> THEN rule', () => {
  const result = parseSentence('When the customer is eligible, then approve the request.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  // action starts with a decision verb ("approve"), so this is classified as a decision, not a bare rule.
  assert.equal(c.nodeType, 'decision');
  assert.equal(c.condition, 'the customer is eligible');
  assert.equal(c.outcome, 'approve the request');
});

test('multi-condition rule (AND) keeps the whole condition clause intact', () => {
  const result = parseSentence('If the customer is eligible and the amount is under $500, approve the request.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'decision');
  assert.equal(c.condition, 'the customer is eligible and the amount is under $500');
});

test('prerequisite: "Before A, B must be completed."', () => {
  const result = parseSentence('Before signing, KYC verification must be completed.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'prerequisite');
  assert.equal(c.condition, 'KYC verification');
  assert.equal(c.action, 'signing');
});

test('prohibition: "Cannot X."', () => {
  const result = parseSentence('Cannot approve a request without identity verification.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prohibition');
});

test('prohibition: "Do not X."', () => {
  const result = parseSentence('Do not disclose confidential client information.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prohibition');
  assert.equal(result.candidates[0]!.action, 'Do not disclose confidential client information');
});

test('policy: "Only managers may approve Y."', () => {
  const result = parseSentence('Only managers may approve refunds over $1000.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'policy');
});

test('policy: "Must be over 18."', () => {
  const result = parseSentence('Must be over 18 to open an account.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'policy');
});

// M1.2 recall addition — the sentence-initial "must" cue above never
// matched real policy language like "The Insured must notify the
// Insurer of a loss within 7 days...", because these obligations have a
// short subject before "must" rather than starting with it. All five
// come verbatim from XO_Commercial_Property_Test_Policy_Compatible.pdf
// §4.1/§4.3/§4.4/§6.1/§6.2 and previously produced zero candidates —
// not merely a low-confidence one.
test('M1.2: subject-prefixed "must" obligation — "The Insured must notify..." (real policy §4.1)', () => {
  const result = parseSentence('The Insured must notify the Insurer of a loss within 7 days after becoming aware of the loss.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'policy');
  assert.equal(c.matchedPattern, 'policy:subject-must-obligation');
  assert.equal(c.action, 'must notify the Insurer of a loss within 7 days after becoming aware of the loss');
});

test('M1.2: subject-prefixed "must" obligation — "The Insured must provide..." (real policy §4.3)', () => {
  const result = parseSentence('The Insured must provide the completed claim form, photographs of the damage and supporting invoices.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.matchedPattern, 'policy:subject-must-obligation');
});

test('M1.2: subject-prefixed "must" obligation — "The Insured must take reasonable steps..." (real policy §4.4)', () => {
  const result = parseSentence('The Insured must take reasonable steps to prevent further damage after an insured event.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.matchedPattern, 'policy:subject-must-obligation');
});

test('M1.2: subject-prefixed "must" obligation — "The Insured must report suspected theft..." (real policy §6.1)', () => {
  const result = parseSentence('The Insured must report suspected theft to the police as soon as reasonably practicable.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.matchedPattern, 'policy:subject-must-obligation');
});

test('M1.2: subject-prefixed "must" obligation — "The Insured must preserve damaged property..." (real policy §6.2)', () => {
  const result = parseSentence('The Insured must preserve damaged property for inspection unless doing so would increase the risk of further damage.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.matchedPattern, 'policy:subject-must-obligation');
});

test('M1.2 negative: a "must" buried past a long (>4 word) leading clause is not mistaken for this sentence\'s top-level obligation', () => {
  const result = parseSentence('The party responsible for reviewing the annual compliance summary before the board meeting must sign off.');
  assert.equal(result.candidates.length, 0);
});

test('M1.2 negative: an unrelated sentence with no "must" at all still does not match this pattern', () => {
  const result = parseSentence('The claim was reviewed by a senior adjuster on Tuesday.');
  assert.equal(result.candidates.length, 0);
});

test('M1.2 regression: the pre-existing sentence-initial "must" pattern is unchanged by the new subject-prefixed branch', () => {
  const result = parseSentence('Must be over 18 to open an account.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.matchedPattern, 'policy:must-obligation');
  assert.equal(result.candidates[0]!.action, 'Must be over 18 to open an account');
});

test('exception via inline UNLESS clause: produces a rule + a companion exception node + an overrides edge', () => {
  const result = parseSentence('If the order is late, cancel it unless the customer has a premium subscription.');
  assert.equal(result.candidates.length, 2);
  const rule = result.candidates.find((c) => c.nodeType === 'rule' || c.nodeType === 'decision')!;
  const exception = result.candidates.find((c) => c.nodeType === 'exception')!;
  assert.ok(rule);
  assert.ok(exception);
  assert.deepEqual(rule.exceptionConditions, ['the customer has a premium subscription']);
  assert.equal(exception.condition, 'the customer has a premium subscription');
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]!.type, 'overrides');
  assert.equal(result.edges[0]!.fromLabel, exception.canonicalLabel);
  assert.equal(result.edges[0]!.toLabel, rule.canonicalLabel);
});

test('alternative via IF/THEN/ELSE (OTHERWISE): produces two candidates linked by alternative_to', () => {
  const result = parseSentence('If the customer is eligible, approve the loan otherwise refer to underwriting.');
  assert.equal(result.candidates.length, 2);
  const decision = result.candidates.find((c) => c.nodeType === 'decision')!;
  const alt = result.candidates.find((c) => c.nodeType === 'alternative')!;
  assert.ok(decision);
  assert.ok(alt);
  assert.equal(alt.action, 'refer to underwriting');
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]!.type, 'alternative_to');
});

test('standalone alternative: "Option A is preferred when condition X holds."', () => {
  const result = parseSentence('Expedited shipping is preferred when the order value exceeds $200.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'alternative');
  assert.equal(c.outcome, 'Expedited shipping');
  assert.equal(c.condition, 'the order value exceeds $200');
});

test('decision: "If the customer is eligible, approve the request."', () => {
  const result = parseSentence('If the customer is eligible, approve the request.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'decision');
  assert.equal(c.outcome, 'approve the request');
});

test('decision + outcome: "If not eligible, reject the request."', () => {
  const result = parseSentence('If not eligible, reject the request.');
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'decision');
  assert.equal(c.outcome, 'reject the request');
  assert.equal(c.condition, 'not eligible');
});

test('justification: "Because E, D."', () => {
  const result = parseSentence('Because the contract lacks a signature, the agreement was voided.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'justification');
  assert.equal(c.rationale, 'the contract lacks a signature');
  assert.equal(c.outcome, 'the agreement was voided');
});

test('justification: "D, because E." (trailing form)', () => {
  const result = parseSentence('The agreement was voided because the contract lacks a signature.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'justification');
  assert.equal(c.outcome, 'The agreement was voided');
  assert.equal(c.rationale, 'the contract lacks a signature');
});

// M1.3: "<condition clause> satisfies/does not satisfy <requirement>."
// — real policy §8.1/§8.2, previously zero extraction (no leading
// "if"/"when"/"must"/etc. cue at all).
test('M1.3: "X satisfies the requirement." (real policy §8.1)', () => {
  const result = parseSentence('A claim notification received within 7 calendar days of the reported loss date satisfies the notification requirement.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'rule');
  assert.equal(c.matchedPattern, 'rule:satisfies');
  assert.equal(c.condition, 'A claim notification received within 7 calendar days of the reported loss date');
  assert.equal(c.action, 'satisfies the notification requirement');
});

test('M1.3: "X does not satisfy the requirement." (real policy §8.2)', () => {
  const result = parseSentence('A claim notification received more than 7 calendar days after the reported loss date does not satisfy the standard notification requirement.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'rule');
  assert.equal(c.matchedPattern, 'rule:does-not-satisfy');
  assert.equal(c.condition, 'A claim notification received more than 7 calendar days after the reported loss date');
  assert.equal(c.action, 'does not satisfy the standard notification requirement');
});

test('M1.3 negative: a sentence with no "satisfies"/"does not satisfy" phrase at all does not match this pattern', () => {
  const result = parseSentence('The claim was reviewed by a senior adjuster on Tuesday.');
  assert.equal(result.candidates.length, 0);
});

test('M1.3 negative: "satisfies" with nothing before it is not mistaken for a condition clause', () => {
  const result = parseSentence('Satisfies the requirement.');
  assert.equal(result.candidates.length, 0);
});

test('standalone override: "Exception E overrides rule R."', () => {
  const result = parseSentence('The force majeure exception overrides the delivery deadline rule.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'exception');
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]!.type, 'overrides');
});

// --- Phase 1: new rule-recall patterns --------------------------------------

test('subject-to prerequisite: "Subject to A, B." (real fixture form)', () => {
  const result = parseSentence('Subject to satisfactory proof of loss, the insurer will process the claim within 14 days.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'prerequisite');
  assert.equal(c.condition, 'satisfactory proof of loss');
  assert.equal(c.action, 'the insurer will process the claim within 14 days');
});

test('subject-to negative: mid-sentence "is subject to" (real burglary-policy.pdf form) is NOT a leading conditional and is left unmatched', () => {
  const result = parseSentence('This policy is subject to the standard policy wordings, warranties, exclusions and conditions as per Digit Burglary Insurance Policy.');
  assert.equal(result.candidates.length, 0);
});

test('trailing conditional: "Action, if condition." (real burglary-policy.pdf form)', () => {
  const result = parseSentence('The policy is not valid, if any of the information provided is incorrect.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'rule');
  assert.equal(c.action, 'The policy is not valid');
  assert.equal(c.condition, 'any of the information provided is incorrect');
});

test('trailing conditional negative: a short parenthetical "if" aside (one word after "if") is conservatively skipped', () => {
  const result = parseSentence('The claim was processed quickly, if inconsistently.');
  assert.equal(result.candidates.length, 0);
});

test('trailing conditional negative: no comma-adjacent "if" at all', () => {
  const result = parseSentence('The office is open on weekdays, and questions are welcome.');
  assert.equal(result.candidates.length, 0);
});

test('passive exclusion: "X is excluded." (real burglary-policy.pdf form)', () => {
  const result = parseSentence('Terrorism cover is excluded');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'prohibition');
  assert.equal(c.action, 'Terrorism cover is excluded');
});

test('passive exclusion: "X are not covered." (synthetic fixture form)', () => {
  const result = parseSentence('War and nuclear risk are not covered.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prohibition');
});

test('passive exclusion: trailing-qualified form (real burglary-policy.pdf form) still matches mid-sentence', () => {
  const result = parseSentence('Jewellery shops, Goldsmiths, Silversmiths, Money Lenders, Pawn brokers and alike are excluded from scope of cover under the policy.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prohibition');
});

test('passive exclusion negative: "excluded" as a plain adjective, not the "is/are excluded" verb phrase', () => {
  const result = parseSentence('The excluded party could not attend the meeting.');
  assert.equal(result.candidates.length, 0);
});

test('warranty: "Warranted that X." (synthetic fixture form)', () => {
  const result = parseSentence('Warranted that a working smoke detector is installed on every floor.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'policy');
  assert.equal(c.action, 'a working smoke detector is installed on every floor');
});

test('warranty: "Warranted X." without "that" (real burglary-policy.pdf form)', () => {
  const result = parseSentence('Warranted existing protection, detection and alarm system to be maintained in well working condition throughout policy period.');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  assert.equal(c.nodeType, 'policy');
  assert.equal(c.matchedPattern, 'policy:warranted');
});

test('warranty negative: "warranty" as an ordinary noun elsewhere in the sentence, not the leading "Warranted" cue', () => {
  const result = parseSentence('The warranty period lasts one year from the date of purchase.');
  assert.equal(result.candidates.length, 0);
});

test('priority: a sentence starting with "Warranted that ... are excluded ..." is classified once, as a warranty (not double-counted as an exclusion too)', () => {
  const result = parseSentence('Warranted that stocks/goods stored in open, money, monetary instruments and valuables of every kind and description are excluded from scope of cover under the policy.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'policy');
});



test('an ambiguous sentence with no supported pattern produces no candidates', () => {
  const result = parseSentence('The weather was pleasant that afternoon.');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.edges.length, 0);
});

test('an IF-clause with no comma to split on is conservatively skipped rather than guessed', () => {
  const result = parseSentence('If eligible approve the request without a clear separator.');
  assert.equal(result.candidates.length, 0);
});

test('an empty sentence produces no candidates', () => {
  const result = parseSentence('   ');
  assert.equal(result.candidates.length, 0);
});

test('only the first matching pattern applies (priority order is deterministic, not ambiguous double-interpretation)', () => {
  // Starts with "before " (prerequisite cue) - must not also fall through to another pattern.
  const result = parseSentence('Before approval, do not skip the compliance check.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prerequisite');
});

// ---------------------------------------------------------------------------
// Leading clause-number stripping (stripLeadingClauseNumber, applied once in
// parseSentence): real benchmark documents (XO_Commercial_Property_Test_
// Policy_Compatible.pdf) prefix every clause with a dotted number, which
// otherwise defeats every leading-cue pattern above. See rule-pattern-
// parser.ts's own doc comment on this for the full evidence and rationale.
// ---------------------------------------------------------------------------

test('clause number: "7.1 If A, B." is recognized exactly like "If A, B." once the leading "7.1 " is stripped', () => {
  const numbered = parseSentence('7.1 If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.');
  const bare = parseSentence('If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.');
  assert.equal(numbered.candidates.length, 1);
  assert.deepEqual(numbered.candidates, bare.candidates);
  const c = numbered.candidates[0]!;
  assert.equal(c.nodeType, 'rule'); // "manager approval is required" isn't a decision verb -> canonical kind 'heuristic', which does carry an outcome
  assert.equal(c.condition, 'the claim amount is greater than INR 10,000 and all required documents are present');
  assert.equal(c.action, 'manager approval is required');
});

test('clause number: a three-level marker ("11.3.2 ") is stripped the same way as a two-level one', () => {
  const result = parseSentence('11.3.2 If the loss is covered, approve the claim.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'decision');
  assert.equal(result.candidates[0]!.condition, 'the loss is covered');
});

test('clause number: a single-level top-of-section marker ("1. ") is stripped too', () => {
  const result = parseSentence('1. Before settlement, an inspection must occur.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.nodeType, 'prerequisite');
});

test('clause number: stripping applies uniformly to every leading-cue pattern, not only "if"/"when"', () => {
  assert.equal(parseSentence('5.7 Warranted that all fire extinguishing equipment is maintained in working order.').candidates[0]!.nodeType, 'policy');
  assert.equal(parseSentence('7.4 Only claims with an active Policy may be considered for settlement.').candidates[0]!.nodeType, 'policy');
  assert.equal(parseSentence('4.1 The Insured must notify the Insurer of a loss within 7 days.').candidates[0]!.nodeType, 'policy');
  assert.equal(parseSentence('6.6 Before payment is released, all required approvals must be recorded in the claim file.').candidates[0]!.nodeType, 'prerequisite');
});

test('clause number: a bare leading number with NO dot ("30 days after...") is left untouched, not treated as a marker', () => {
  // Guards the documented false-positive risk: "N " alone (a duration/quantity) is ordinary
  // sentence content, not a clause number, and must never be stripped.
  const result = parseSentence('30 days after the loss, the claim expires.');
  assert.equal(result.candidates.length, 0); // doesn't start with any supported cue, stripped or not — unchanged by this fix
});

test('clause number: a decimal value genuinely at sentence-start with no following whitespace after the marker-shaped part is left alone', () => {
  // "7.1kg" has no whitespace immediately after the digit/dot run ('k' follows directly), so it
  // must never be treated as a clause number and stripped down to "kg is the maximum weight...".
  const result = parseSentence('7.1kg is the maximum weight, if the item is fragile.');
  assert.equal(result.candidates.length, 1);
  // parseTrailingConditional's mid-sentence "if" is unaffected by clause-number stripping either
  // way, so it correctly still matches — but the ACTION text must retain "7.1kg" intact, proving
  // stripLeadingClauseNumber did not fire on it.
  assert.equal(result.candidates[0]!.action, '7.1kg is the maximum weight');
});

test('clause number: an unnumbered sentence is completely unaffected (no regression to any existing pattern)', () => {
  const result = parseSentence('If the payment is late, apply a penalty fee.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.condition, 'the payment is late');
});

test('clause number: a lone clause-number "sentence" with nothing else produces no candidates, never a crash', () => {
  const result = parseSentence('7.1');
  assert.equal(result.candidates.length, 0);
});

test('clause number: provenance offsets still cover the ORIGINAL numbered sentence text, not the stripped text (see rule-based-extractor.ts — offsets are computed by the sentence splitter before parseSentence ever runs)', () => {
  // This is a parser-level unit test, so it only re-confirms parseSentence's contract (it
  // receives and matches against a string) — the offset-preservation claim itself is exercised
  // by rule-based-extractor.test.ts's existing provenance assertions, unmodified by this change.
  const result = parseSentence('2.4 If the claim amount exceeds INR 10,000, the claim requires manager approval before settlement.');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.condition, 'the claim amount exceeds INR 10,000');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedCapabilityExtractor } from '../../src/capabilities/rule-based-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import type { KnowledgeGraph } from '../../src/knowledge/types.js';

function makeUnit(overrides: Partial<ExperienceUnit>): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Untitled',
    headingTitle: undefined,
    semanticType: 'general',
    content: '',
    provenance: { documentPath: 'doc.pdf', pages: [1], sectionPath: ['Intro'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 0, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
    ...overrides,
  };
}

const emptyGraph: KnowledgeGraph = { nodes: [], edges: [] };
const extractor = new RuleBasedCapabilityExtractor();

test('detects a true imperative sentence with higher confidence', async () => {
  const unit = makeUnit({ content: 'Send the notice to all parties within five days.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.equal(cap!.confidence, 0.6);
});

test('detects a modal-obligation phrasing with medium confidence', async () => {
  const unit = makeUnit({ content: 'The Receiving Party shall notify the Disclosing Party immediately.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.equal(cap!.confidence, 0.55);
});

test('detects a title-based capability from a category keyword in a genuine authored heading', async () => {
  const unit = makeUnit({ title: 'Risk Analysis', headingTitle: 'Risk Analysis', content: 'This section covers general considerations.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.localId === 'title');
  assert.ok(cap);
  assert.equal(cap!.category, 'analysis');
  assert.equal(cap!.name, 'Risk Analysis');
});

test('does NOT detect a title-based capability when the same category keyword only appears in a synthesized (headless) title, not a genuine heading', async () => {
  // Same words as the positive case above, but headingTitle is undefined — modeling a
  // unit whose title was synthesized from its own leading content (synthesizeTitle in
  // unit-builder.ts), not borrowed from an authored section.heading. See the ExperienceUnit
  // doc comment and CHANGELOG.md's Layer 1A entry.
  const unit = makeUnit({ title: 'Risk Analysis', headingTitle: undefined, content: 'This section covers general considerations.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.localId === 'title');
  assert.equal(cap, undefined);
});

test('headless prose whose synthesized title happens to contain a category keyword does not get title/category capability evidence (the real Aastha false positive)', async () => {
  // "Reconcile the invoice balance against actual receipts received." is exactly 8 words —
  // synthesizeTitle's MAX_TITLE_WORDS — so it becomes the unit's whole title verbatim, no
  // ellipsis marker distinguishing it from a real heading. Its "invoice" would match
  // CATEGORY_TITLE_KEYWORDS if headingTitle weren't checked. The verb path ("Reconcile") is
  // untouched and still fires — see the assertion below.
  const content = 'Reconcile the invoice balance against actual receipts received.';
  const unit = makeUnit({ title: content, headingTitle: undefined, content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.capabilities.find((c) => c.localId === 'title'), undefined, 'must not produce a title-path capability');
  assert.ok(result.value.capabilities.some((c) => c.category === 'validation' && c.name.startsWith('Reconcile')), 'the legitimate verb-based capability must still be detected');
});

test('detects a command-snippet-based capability with parsed inputs', async () => {
  const unit = makeUnit({ content: 'Use sendEmail(to, subject, body) to notify the client.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.name === 'sendEmail');
  assert.ok(cap);
  assert.equal(cap!.category, 'execution');
  assert.deepEqual(cap!.inputs, ['to', 'subject', 'body']);
  assert.deepEqual(cap!.examples, ['sendEmail(to, subject, body)']);
});

test('links a capability to knowledge nodes mentioned in the same sentence', async () => {
  const unit = makeUnit({ content: 'Send the report to Acme Corp promptly.' });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [{ id: 'kn_1' as never, semanticType: 'organization', canonicalLabel: 'Acme Corp', aliases: [], confidence: 0.8, provenance: [], metadata: {} }],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.ok(cap!.requiredKnowledgeNodeIds.includes('kn_1'));
});

test('produces no edges of its own', async () => {
  const unit = makeUnit({ content: 'Send the report promptly.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.edges, []);
});

test('never fails, even for empty content', async () => {
  const unit = makeUnit({ content: '' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.equal(result.ok, true);
});

test('produces no capabilities for text with no verb, title keyword, or snippet', async () => {
  const unit = makeUnit({ title: 'Miscellaneous', content: 'The sky is blue today.' });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.capabilities, []);
});

// --- Cross-domain verb-lexicon coverage extension (Action/Process Realization milestone, §3) ---

test('each newly added cross-domain verb produces a capability candidate', async () => {
  const cases: { readonly content: string; readonly category: string }[] = [
    { content: 'Match CRM records vs. Insurer statements.', category: 'validation' },
    { content: 'Reconcile invoice amounts vs. receipt amounts.', category: 'validation' },
    { content: 'Authenticate before calling an endpoint.', category: 'validation' },
    { content: 'Calculate the channel-wise revenue share.', category: 'transformation' },
    { content: 'Handle a response.', category: 'execution' },
    { content: 'Retry a failed request.', category: 'execution' },
    { content: 'Install the dependency.', category: 'execution' },
    { content: 'Configure the environment.', category: 'execution' },
    { content: 'Restart the service.', category: 'execution' },
    { content: 'Deploy the service.', category: 'execution' },
    { content: 'Record the result in the system.', category: 'generation' },
    { content: 'Book the receipt in Tally Prime.', category: 'generation' },
    { content: 'Escalate unresolved cases.', category: 'communication' },
  ];
  for (const { content, category } of cases) {
    const unit = makeUnit({ content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok, `extraction failed for "${content}"`);
    if (!result.ok) continue;
    const cap = result.value.capabilities.find((c) => c.category === category);
    assert.ok(cap, `expected a "${category}" capability for "${content}", got: ${JSON.stringify(result.value.capabilities.map((c) => c.category))}`);
  }
});

// --- Stage 5 capability -> knowledge evidence recovery (same-ExperienceUnit action/process fallback) ---

test('recovers a same-unit action node when its canonical label was truncated (does not appear verbatim)', async () => {
  const unit = makeUnit({
    id: 'unit-trunc' as ExperienceUnit['id'],
    content: 'Record incoming payments (which typically include TDS deductions by the insurer).',
  });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [
      {
        id: 'kn_action' as never,
        semanticType: 'action',
        canonicalLabel: 'Record incoming payments (which typically…',
        aliases: [],
        confidence: 0.7,
        provenance: [{ experienceUnitId: 'unit-trunc', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.7 }],
        metadata: {},
      },
    ],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'generation' || c.description.includes('Record incoming payments'));
  assert.ok(cap, `expected a capability for the sentence, got: ${JSON.stringify(result.value.capabilities)}`);
  assert.ok(cap!.requiredKnowledgeNodeIds.includes('kn_action'));
});

test('does not recover a same-unit process node whose canonical label matches exactly (exact-label path still used, no duplicate/behavior change)', async () => {
  const unit = makeUnit({ id: 'unit-exact' as ExperienceUnit['id'], content: 'Escalate unresolved cases to compliance.' });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [
      {
        id: 'kn_process' as never,
        semanticType: 'process',
        canonicalLabel: 'Escalate unresolved cases',
        aliases: [],
        confidence: 0.7,
        provenance: [{ experienceUnitId: 'unit-exact', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.7 }],
        metadata: {},
      },
    ],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.deepEqual(cap!.requiredKnowledgeNodeIds, ['kn_process']);
});

test('a same-unit concept/entity node is NOT recovered as a capability dependency merely by unit membership', async () => {
  const unit = makeUnit({ id: 'unit-concept' as ExperienceUnit['id'], content: 'Send the report to the Underwriting Team.' });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [
      {
        id: 'kn_concept' as never,
        semanticType: 'concept',
        canonicalLabel: 'Some unrelated concept never mentioned verbatim here',
        aliases: [],
        confidence: 0.7,
        provenance: [{ experienceUnitId: 'unit-concept', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.7 }],
        metadata: {},
      },
      {
        id: 'kn_entity' as never,
        semanticType: 'entity',
        canonicalLabel: 'Also unrelated and not mentioned',
        aliases: [],
        confidence: 0.6,
        provenance: [{ experienceUnitId: 'unit-concept', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.6 }],
        metadata: {},
      },
    ],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.category === 'communication');
  assert.ok(cap);
  assert.deepEqual(cap!.requiredKnowledgeNodeIds, []);
  assert.deepEqual(cap!.relatedConcepts, []);
});

test('an action node from a DIFFERENT ExperienceUnit is not recovered merely because it shares vocabulary', async () => {
  const unit = makeUnit({ id: 'unit-a' as ExperienceUnit['id'], content: 'Record incoming payments promptly.' });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [
      {
        id: 'kn_other_unit_action' as never,
        semanticType: 'action',
        canonicalLabel: 'Record incoming payments (from a different…',
        aliases: [],
        confidence: 0.7,
        provenance: [{ experienceUnitId: 'unit-b', documentPath: 'doc.pdf', pages: [2], sectionPath: [], charOffsetRange: undefined, confidence: 0.7 }],
        metadata: {},
      },
    ],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.description.includes('Record incoming payments'));
  assert.ok(cap);
  assert.deepEqual(cap!.requiredKnowledgeNodeIds, []);
});

test('the title-based capability path also benefits from same-unit action recovery', async () => {
  const unit = makeUnit({
    id: 'unit-title' as ExperienceUnit['id'],
    title: 'Payment Processing Review',
    headingTitle: 'Payment Processing Review',
    content: 'Reconcile the invoice balance against the statement, which typically requires cross-checking three separate ledgers.',
  });
  const knowledgeGraph: KnowledgeGraph = {
    nodes: [
      {
        id: 'kn_review_action' as never,
        semanticType: 'action',
        canonicalLabel: 'Reconcile the invoice balance against the…',
        aliases: [],
        confidence: 0.7,
        provenance: [{ experienceUnitId: 'unit-title', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.7 }],
        metadata: {},
      },
    ],
    edges: [],
  };
  const result = await extractor.extract(unit, knowledgeGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const titleCap = result.value.capabilities.find((c) => c.localId === 'title');
  assert.ok(titleCap);
  assert.ok(titleCap!.requiredKnowledgeNodeIds.includes('kn_review_action'));
});

test('the lexicon extension does not introduce new false positives on ordinary descriptive prose', async () => {
  const negatives = [
    'The weather was pleasant throughout the reconciliation period.',
    'CRM stands for Customer Relationship Management.',
    'Insurance brokers typically work with multiple insurers.',
  ];
  for (const content of negatives) {
    const unit = makeUnit({ title: 'Untitled', content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.deepEqual(result.value.capabilities, [], `expected no capabilities for "${content}"`);
  }
});

// --- Layer 1B (P0.9 Beta, see benchmark/CHANGELOG.md): a "vs." sentence stays one capability, untruncated ---

test('a capability-bearing sentence containing "vs." is captured whole, not truncated at "vs."', async () => {
  const content = 'Reconcile invoice amounts vs. receipt amounts against Statement figures.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.name.startsWith('Reconcile'));
  assert.ok(cap);
  assert.equal(cap!.description, content, 'the full sentence, including the "vs." clause, must be captured — not truncated at "vs."');
});

// --- Layer 2B (P0.9 Beta, see benchmark/CHANGELOG.md): active-voice verb inflection ("-s", "-ed") ---

test('active third-person-singular present tense ("-s") is recognized: the real Aastha gap ("The CRM generates...")', async () => {
  const content = 'The CRM generates a "Policy Booking Report" for a custom date or period.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const cap = result.value.capabilities.find((c) => c.name.startsWith('Generate'));
  assert.ok(cap, '"generates" must be recognized via its base form "generate"');
  assert.equal(cap!.category, 'generation');
});

test('active third-person-singular present tense ("-s") is recognized for other lexicon verbs', async () => {
  const cases: readonly [string, string][] = [
    ['The system reconciles invoice amounts against receipts daily.', 'Reconcile'],
    ['The engine calculates the brokerage percentage automatically.', 'Calculate'],
  ];
  for (const [content, expectedPrefix] of cases) {
    const unit = makeUnit({ title: 'Untitled', content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.ok(result.value.capabilities.some((c) => c.name.startsWith(expectedPrefix)), `expected a "${expectedPrefix}"-prefixed capability for "${content}"`);
  }
});

test('active past tense ("-ed") is recognized without requiring passive-auxiliary phrasing', async () => {
  const cases: readonly [string, string][] = [
    ['The clerk reconciled the accounts at month end.', 'Reconcile'],
    ['The analyst calculated the total payable amount.', 'Calculate'],
    ['The technician configured the new server yesterday.', 'Configure'],
  ];
  for (const [content, expectedPrefix] of cases) {
    const unit = makeUnit({ title: 'Untitled', content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.ok(result.value.capabilities.some((c) => c.name.startsWith(expectedPrefix)), `expected a "${expectedPrefix}"-prefixed capability for "${content}"`);
  }
});

test('a plural noun ending in "-s" immediately after a determiner is NOT mistaken for a verb', async () => {
  const content = 'The records are stored in the archive for seven years.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(!result.value.capabilities.some((c) => c.name.toLowerCase().startsWith('record')), '"records" (a determiner-preceded plural noun) must not be read as the verb "record"');
});

test('a plural noun ending in "-s" immediately before an auxiliary/copula is NOT mistaken for a verb, even without a preceding determiner', async () => {
  const cases = ['Database records have grown significantly this year.', 'The matches were postponed due to weather.'];
  for (const content of cases) {
    const unit = makeUnit({ title: 'Untitled', content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.deepEqual(result.value.capabilities, [], `expected no capabilities for "${content}"`);
  }
});

test('noun/verb ambiguity is resolved by local context, not by the lemma alone: the same verb is accepted or rejected per sentence', async () => {
  const positive = await extractor.extract(makeUnit({ title: 'Untitled', content: 'The referee matches players of similar skill level.' }), emptyGraph);
  assert.ok(positive.ok);
  if (positive.ok) assert.ok(positive.value.capabilities.some((c) => c.name.startsWith('Match')), '"matches" as a genuine verb (object follows, no determiner before) must still be recognized');

  const negative = await extractor.extract(makeUnit({ title: 'Untitled', content: 'The matches were postponed due to weather.' }), emptyGraph);
  assert.ok(negative.ok);
  if (negative.ok) assert.deepEqual(negative.value.capabilities, [], '"matches" as a noun subject (determiner before, aux after) must not be recognized in the same lemma');
});

test('a passive sentence with a noun/verb-ambiguous subject still correctly captures its own genuine passive verb', async () => {
  // "records" (subject, correctly rejected as a verb) is immediately followed by "are reviewed" — a
  // genuine passive-voice capability ("reviewed") that the existing passive mechanism should still catch.
  const content = 'Financial records are reviewed annually by the auditor.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(!result.value.capabilities.some((c) => c.name.toLowerCase().startsWith('record')), '"records" itself must still not be read as a verb');
  assert.ok(result.value.capabilities.some((c) => c.name.startsWith('Review')), 'the genuine passive verb "reviewed" in the same sentence must still be captured');
});

test('a reduced relative clause ("a document created solely to exercise...") is NOT mistaken for an active main-clause action', async () => {
  // The exact real regression this guard exists for: synthetic-property-policy-quality.test.ts's
  // fixture boilerplate ("...document created solely to exercise the XO compiler's...") was briefly
  // misread as an active "Create" capability once "-ed" active-voice matching was added.
  const content = "This is a synthetic, non-real property insurance policy document created solely to exercise the XO compiler's semantic extraction pipeline end to end.";
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.capabilities, [], 'a participle modifying a preceding noun, followed by an adverb, must not be read as a genuine active-voice event');
});

test('a reduced relative clause followed by a preposition ("reports generated from the CRM", "data validated by the auditor") is NOT mistaken for an active main-clause action', async () => {
  // The real Aastha case: "...based on the 'Policy Booked' reports generated from the CRM." — a
  // participle modifying "reports", not a real event; "generated" is immediately followed by "from",
  // never a direct object, since the reduced relative clause has none of its own to give.
  const cases = ['...based on the "Policy Booked" reports generated from the CRM.', 'The figures were checked against data validated by the auditor last quarter.'];
  for (const content of cases) {
    const unit = makeUnit({ title: 'Untitled', content });
    const result = await extractor.extract(unit, emptyGraph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.ok(!result.value.capabilities.some((c) => c.name.startsWith('Generate') || c.name.startsWith('Validate')), `expected no "Generate"/"Validate" capability for "${content}"`);
  }
});

test('a word cited verbatim inside quotation marks (a report/label name, e.g. "Policy Booked") is never read as a verb by the active-voice fallbacks', async () => {
  // Same real Aastha sentence as above, isolated to the specific mechanism: "Booked" (inside
  // quotes, part of the report's literal name "Policy Booked") must not itself be read as the verb
  // "book", even though "book" is a real lexicon entry and nothing else here blocks it (no adverb,
  // no preposition immediately follows "Booked" — "reports" does).
  const content = 'This report is called the "Policy Booked" reports export.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(!result.value.capabilities.some((c) => c.name.toLowerCase().startsWith('book')), 'a quoted label must not be read as an active-voice verb');
});

test('existing passive-voice behavior (both categories and the execution exclusion) is unaffected by the active-voice additions', async () => {
  const create = await extractor.extract(makeUnit({ title: 'Untitled', content: 'Invoices are created automatically at the end of each cycle.' }), emptyGraph);
  assert.ok(create.ok);
  if (create.ok) assert.ok(create.value.capabilities.some((c) => c.name.startsWith('Create')));

  const configured = await extractor.extract(makeUnit({ title: 'Untitled', content: 'The server is configured with default settings.' }), emptyGraph);
  assert.ok(configured.ok);
  if (configured.ok) assert.deepEqual(configured.value.capabilities, [], 'passive "execution"-category phrasing ("is configured") must still be excluded, unchanged');
});

test('a sentence-initial past-tense participle with no subject ("Validated reconciliation data.") is NOT mistaken for an imperative or active-voice event', async () => {
  // The other real Aastha case, from the still-open, already-documented unit-builder.ts
  // groupBlocks residual gap (see benchmark/CHANGELOG.md's Layer 0 entry): a fragment
  // ("validated reconciliation data.") ends up capitalized as if it starts a new sentence.
  // Unlike a base-form imperative ("Reconcile the accounts." — a normal instruction), a
  // sentence-initial past-tense verb with no subject is not a grammatical English sentence at
  // all, and is far more likely to be exactly this kind of reconstruction artifact.
  const content = 'validated reconciliation data.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.capabilities, [], 'a subjectless, sentence-initial past-tense participle must not be read as a genuine active-voice event');
});

test('a base-form imperative as the first word of a sentence is unaffected by the sentence-initial-past-tense guard (still a genuine command)', async () => {
  const content = 'Reconcile the accounts before month end.';
  const unit = makeUnit({ title: 'Untitled', content });
  const result = await extractor.extract(unit, emptyGraph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.capabilities.some((c) => c.name.startsWith('Reconcile')), 'a base-form sentence-initial imperative is untouched — the new guard only applies to "-ed" forms');
});

test('a modal followed by the bare passive infinitive ("must be recorded", "must be configured") is treated as genuinely passive, preserving the execution-category exclusion', async () => {
  // "be" after a modal (must/shall/should/...) is just as passive as "is/are/was/were" — routing it
  // through the active-past-tense branch instead would have let an execution-category verb slip
  // through unexcluded ("must be configured" incorrectly becoming an active "Configure" capability).
  const recorded = await extractor.extract(makeUnit({ title: 'Untitled', content: 'All required approvals must be recorded in the claim file.' }), emptyGraph);
  assert.ok(recorded.ok);
  if (recorded.ok) assert.ok(recorded.value.capabilities.some((c) => c.name.startsWith('Record') && c.category === 'generation'), 'a non-execution-category verb ("record") must still be captured via the passive path');

  const configured = await extractor.extract(makeUnit({ title: 'Untitled', content: 'The system must be configured before go-live.' }), emptyGraph);
  assert.ok(configured.ok);
  if (configured.ok) assert.deepEqual(configured.value.capabilities, [], 'an execution-category verb ("configure") after a modal+bare-"be" passive must still be excluded, exactly like "is configured"');
});

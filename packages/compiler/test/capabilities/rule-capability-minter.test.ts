import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceDocument, ExperienceUnit } from '../../src/semantic/types.js';
import { extractReasoningGraph } from '../../src/reasoning/reasoning-extractor.js';
import { mintRuleLevelCapabilities, RULE_DERIVED_METADATA_KEY, RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY } from '../../src/capabilities/rule-capability-minter.js';

// Mirrors ../reasoning/reasoning-extractor.test.ts' own helpers exactly —
// see that file for the rationale (real extraction end-to-end, never a
// hand-built ReasoningNode literal that could drift from what the
// extractor actually produces).
function makeUnit(overrides: Partial<ExperienceUnit> & { content: string }): ExperienceUnit {
  return {
    id: (overrides.id ?? 'unit-1') as ExperienceUnit['id'],
    title: overrides.title ?? 'Unit',
    semanticType: overrides.semanticType ?? 'clause',
    content: overrides.content,
    provenance: overrides.provenance ?? { documentPath: 'doc.pdf', pages: [1], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: overrides.hierarchy ?? { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: overrides.confidence ?? 0.8,
    relationships: overrides.relationships ?? [],
    documentReferences: overrides.documentReferences ?? [],
    metadata: overrides.metadata ?? {},
  };
}

function makeDocument(units: readonly ExperienceUnit[]): ExperienceDocument {
  return { documentPath: 'doc.pdf', documentTitle: 'Doc', units, relationshipGraph: { relationships: [] } };
}

async function mintFrom(content: string) {
  const graph = await extractReasoningGraph(makeDocument([makeUnit({ content })]));
  return { graph, minted: mintRuleLevelCapabilities(graph) };
}

// ---------------------------------------------------------------------------
// 1. Single numeric comparison — the real policy's "> INR 100,000" shape.
// ---------------------------------------------------------------------------

test('M1.1 shape 1 — single numeric comparison: mints a dedicated capability', async () => {
  const { graph, minted } = await mintFrom('If the claim amount exceeds INR 100,000, then a loss-adjuster assessment is required before settlement.');
  assert.equal(minted.length, 1);
  const cap = minted[0]!;
  assert.equal(cap.category, 'action');
  assert.match(cap.canonicalName, /Loss-adjuster Assessment Is Required/i);
  assert.equal(cap.metadata[RULE_DERIVED_METADATA_KEY], 'true');
  assert.equal(cap.metadata[RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY], graph.nodes[0]!.id);
  assert.deepEqual(cap.provenance, graph.nodes[0]!.provenance);
});

// ---------------------------------------------------------------------------
// 2/3. Compound numeric + categorical ("AND all required documents are
//    present") — both the upper (> 10,000) and lower (<= 10,000) threshold
//    shapes from the real policy.
// ---------------------------------------------------------------------------

test('M1.1 shape 2 — compound numeric + categorical (>): mints a dedicated capability via the existing AND grammar', async () => {
  const { minted } = await mintFrom('If the claim amount is greater than INR 10,000 and all required documents are present, then manager approval is required.');
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0]!.metadata[RULE_DERIVED_METADATA_KEY], 'true');
});

test('M1.1 shape 3 — compound numeric + categorical (<=): mints a dedicated capability via the existing AND grammar', async () => {
  const { minted } = await mintFrom('If the claim amount is less than or equal to INR 10,000 and all required documents are present, then manager approval is not required.');
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0]!.metadata[RULE_DERIVED_METADATA_KEY], 'true');
});

// ---------------------------------------------------------------------------
// 4. Exception clause — never minted.
// ---------------------------------------------------------------------------

test('M1.1 shape 4 — exception clause: never minted', async () => {
  const { graph, minted } = await mintFrom('If the loss type is flood, then the claim must be denied, unless a flood endorsement is recorded.');
  assert.ok(graph.nodes.length >= 1, 'sanity: the rule itself is still discovered by reasoning extraction');
  assert.equal(minted.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Temporal condition — never minted.
// ---------------------------------------------------------------------------

test('M1.1 shape 5 — temporal condition: never minted', async () => {
  const { graph, minted } = await mintFrom('If the policy has expired before the date of loss, then the claim must be referred for coverage review.');
  assert.ok(graph.nodes.some((n) => n.structuredCondition?.type === 'temporal'), 'sanity: this rule really is discovered with a temporal structured condition');
  assert.equal(minted.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Prerequisite (non-comparison outcome shape) — never minted.
// ---------------------------------------------------------------------------

test('M1.1 shape 6 — prerequisite rule with an unparseable outcome shape: never minted', async () => {
  const { minted } = await mintFrom('If the loss type is theft, then a police report must be present before final settlement.');
  assert.equal(minted.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Bare constraint, no decision outcome — never minted.
// ---------------------------------------------------------------------------

test('M1.1 shape 7 — bare constraint with no outcome: never minted', async () => {
  const { graph, minted } = await mintFrom('Only claims with an active Policy may be considered for settlement.');
  assert.ok(graph.nodes.some((n) => n.outcome === undefined), 'sanity: this really is a bare constraint');
  assert.equal(minted.length, 0);
});

// ---------------------------------------------------------------------------
// 8. Ambiguous / unsupported semantic provision — never minted.
// ---------------------------------------------------------------------------

test('M1.1 shape 8 — ambiguous semantic provision with no structured shape: never minted', async () => {
  const { graph, minted } = await mintFrom('If the customer was treated unfairly, escalate the matter.');
  assert.equal(graph.nodes[0]!.structuredCondition, undefined, 'sanity: no structured condition was extracted at all');
  assert.equal(minted.length, 0);
});

// ---------------------------------------------------------------------------
// Regression / determinism
// ---------------------------------------------------------------------------

test('M1.1 regression: minting is idempotent — identical input yields byte-identical minted capability ids and content', async () => {
  const content = 'If the claim amount exceeds INR 100,000, then a loss-adjuster assessment is required before settlement.';
  const first = await mintFrom(content);
  const second = await mintFrom(content);
  assert.deepEqual(first.minted, second.minted);
});

test('M1.1 regression: two different rules with identical outcome text mint two distinct capabilities, never collapse into one', async () => {
  const doc = makeDocument([
    makeUnit({ id: 'unit-1', content: 'If the claim amount exceeds INR 10,000, then manager approval is required.' }),
    makeUnit({ id: 'unit-2', content: 'If the deductible exceeds INR 50,000, then manager approval is required.' }),
  ]);
  const graph = await extractReasoningGraph(doc);
  const minted = mintRuleLevelCapabilities(graph);
  assert.equal(minted.length, 2, `expected two distinct minted capabilities (one per originating rule), got ${JSON.stringify(minted.map((c) => c.metadata))}`);
  assert.notEqual(minted[0]!.id, minted[1]!.id);
});

test('M1.1 regression: a document with no cleanly-executable rules mints nothing', async () => {
  const { minted } = await mintFrom('If the customer was treated unfairly, escalate the matter.');
  assert.deepEqual(minted, []);
});

// ---------------------------------------------------------------------------
// M1.2 — recall additions
// ---------------------------------------------------------------------------

test('M1.2: "denied" categorical state — "When a claim is denied, ..." now mints a dedicated capability (real policy §9.4)', async () => {
  const { graph, minted } = await mintFrom('When a claim is denied, the system must record the denial reason and the policy clause supporting the decision.');
  assert.deepEqual(graph.nodes[0]!.structuredCondition, { type: 'categorical', field: 'a claim', operator: '==', value: 'denied' });
  assert.equal(minted.length, 1);
  assert.match(minted[0]!.canonicalName, /Record The Denial Reason/i);
});

test('M1.2: subject-prefixed "must" obligations (real policy §4.1/§6.1 shape) are discovered as constraint-kind rules but never minted as executable capabilities', async () => {
  const { graph, minted } = await mintFrom('The Insured must notify the Insurer of a loss within 7 days after becoming aware of the loss.');
  assert.equal(graph.nodes.length, 1, 'sanity: the M1.2 rule-pattern-parser fix means this sentence is now discovered at all');
  assert.equal(graph.nodes[0]!.nodeType, 'policy');
  assert.equal(minted.length, 0, 'a bare obligation/constraint has no decision-table outcome and must never be minted');
});

// ---------------------------------------------------------------------------
// M1.3 — duration-with-field temporal recall
// ---------------------------------------------------------------------------

test('M1.3: "X satisfies the notification requirement" (real policy §8.1, within N days) now mints a dedicated capability', async () => {
  const { graph, minted } = await mintFrom('A claim notification received within 7 calendar days of the reported loss date satisfies the notification requirement.');
  assert.deepEqual(graph.nodes[0]!.structuredCondition, { type: 'temporal', relation: 'within', amount: 7, unit: 'days', field: 'reported loss date' });
  assert.equal(minted.length, 1);
  assert.match(minted[0]!.canonicalName, /Satisfies The Notification Requirement/i);
});

test('M1.3: "X does not satisfy the requirement" (real policy §8.2, more than N days) now mints a dedicated capability', async () => {
  const { graph, minted } = await mintFrom('A claim notification received more than 7 calendar days after the reported loss date does not satisfy the standard notification requirement.');
  assert.deepEqual(graph.nodes[0]!.structuredCondition, { type: 'temporal', relation: 'after', amount: 7, unit: 'days', field: 'reported loss date' });
  assert.equal(minted.length, 1);
});

test('M1.3 negative: an anchor-based temporal rule (real policy §8.5, "policy expired before date of loss") is discovered but still never minted', async () => {
  const { graph, minted } = await mintFrom('If the policy has expired before the date of loss, then the claim must be referred for coverage review.');
  assert.deepEqual(graph.nodes[0]!.structuredCondition, { type: 'temporal', relation: 'before', anchor: 'date of loss' });
  assert.equal(minted.length, 0, 'an anchor-only temporal condition has no runtime-comparable value and must remain unsupported');
});

test('M1.3 negative: a duration temporal rule with no capturable field (no trailing reference phrase) is still never minted', async () => {
  const { graph, minted } = await mintFrom('If a notice is sent within 30 days, then the claim proceeds.');
  assert.equal(graph.nodes[0]!.structuredCondition?.type, 'temporal');
  assert.equal((graph.nodes[0]!.structuredCondition as { field?: string }).field, undefined);
  assert.equal(minted.length, 0);
});


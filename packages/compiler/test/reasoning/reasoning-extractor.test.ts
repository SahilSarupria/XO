import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceDocument, ExperienceUnit } from '../../src/semantic/types.js';
import { extractReasoningGraph } from '../../src/reasoning/reasoning-extractor.js';
import { RuleBasedReasoningExtractor } from '../../src/reasoning/rule-based-extractor.js';

function makeUnit(overrides: Partial<ExperienceUnit> & { content: string }): ExperienceUnit {
  return {
    id: (overrides.id ?? 'unit-1') as ExperienceUnit['id'],
    title: overrides.title ?? 'Unit',
    semanticType: overrides.semanticType ?? 'clause',
    content: overrides.content,
    provenance: overrides.provenance ?? { documentPath: 'doc.pdf', pages: [1], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: overrides.hierarchy ?? { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: overrides.confidence ?? 0.9,
    relationships: overrides.relationships ?? [],
    documentReferences: overrides.documentReferences ?? [],
    metadata: overrides.metadata ?? {},
  };
}

function makeDocument(units: readonly ExperienceUnit[]): ExperienceDocument {
  return { documentPath: 'doc.pdf', documentTitle: 'Doc', units, relationshipGraph: { relationships: [] } };
}

test('RuleBasedReasoningExtractor never fails, always returns ok', async () => {
  const extractor = new RuleBasedReasoningExtractor();
  const result = await extractor.extract(makeUnit({ content: 'The weather was pleasant.' }));
  assert.equal(result.ok, true);
});

test('extractReasoningGraph produces a rule node with provenance from a simple IF/THEN sentence', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the payment is late, apply a penalty fee.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'rule');
  assert.equal(node.provenance.length, 1);
  assert.equal(node.provenance[0]!.documentPath, 'doc.pdf');
});

test('a condition containing "vs." is not split into unrelated fragments (Layer 1B, see benchmark/CHANGELOG.md)', async () => {
  const doc = makeDocument([makeUnit({ content: 'If actual brokerage vs. expected brokerage differs by more than 5%, escalate the case.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1, 'the "vs." clause must not fragment this into extra, unrelated nodes');
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'rule');
  assert.ok(node.condition?.includes('vs. expected brokerage'), 'the condition must retain the full "vs." clause, not be truncated at "vs."');
});

test('condition -> rule, exception -> rule relationships are captured as real edges', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the order is late, cancel it unless the customer has a premium subscription.' })]);
  const graph = await extractReasoningGraph(doc);
  const ruleNode = graph.nodes.find((n) => n.nodeType === 'rule' || n.nodeType === 'decision');
  const exceptionNode = graph.nodes.find((n) => n.nodeType === 'exception');
  assert.ok(ruleNode);
  assert.ok(exceptionNode);
  const overrideEdge = graph.edges.find((e) => e.type === 'overrides');
  assert.ok(overrideEdge);
  assert.equal(overrideEdge!.fromNodeId, exceptionNode!.id);
  assert.equal(overrideEdge!.toNodeId, ruleNode!.id);
});

test('the same rule stated in two different units converges on one node with corroborated confidence', async () => {
  const doc = makeDocument([
    makeUnit({ id: 'u1', content: 'If the payment is late, apply a penalty fee.' }),
    makeUnit({ id: 'u2', content: 'If the payment is late, apply a penalty fee.' }),
  ]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]!.provenance.length, 2);
});

test('determinism: running extraction twice on the same document produces identical node/edge ids and ordering', async () => {
  const doc = makeDocument([
    makeUnit({ id: 'u1', content: 'If the order is late, cancel it unless the customer has a premium subscription.' }),
    makeUnit({ id: 'u2', content: 'Before signing, KYC verification must be completed.' }),
  ]);
  const g1 = await extractReasoningGraph(doc);
  const g2 = await extractReasoningGraph(doc);
  assert.deepEqual(
    g1.nodes.map((n) => n.id),
    g2.nodes.map((n) => n.id),
  );
  assert.deepEqual(
    g1.edges.map((e) => e.id),
    g2.edges.map((e) => e.id),
  );
});

// --- Phase 1: new rule-recall patterns reach full ReasoningNode representation ---

test('a passive exclusion sentence produces a prohibition node with real provenance', async () => {
  const doc = makeDocument([makeUnit({ content: 'Terrorism cover is excluded.', provenance: { documentPath: 'burglary-policy.pdf', pages: [3], sectionPath: ['Exclusions'], blockProvenance: [], blockIndexRange: [0, 0] } })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'prohibition');
  assert.equal(node.action, 'Terrorism cover is excluded');
  assert.equal(node.provenance.length, 1);
  assert.equal(node.provenance[0]!.documentPath, 'burglary-policy.pdf');
});

test('a "Warranted that ..." sentence produces a policy node', async () => {
  const doc = makeDocument([makeUnit({ content: 'Warranted that a working smoke detector is installed on every floor.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]!.nodeType, 'policy');
  assert.equal(graph.nodes[0]!.action, 'a working smoke detector is installed on every floor');
});

test('a leading "Subject to A, B." sentence produces a prerequisite node with condition and action', async () => {
  const doc = makeDocument([makeUnit({ content: 'Subject to satisfactory proof of loss, the insurer will process the claim within 14 days.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'prerequisite');
  assert.equal(node.condition, 'satisfactory proof of loss');
  assert.equal(node.action, 'the insurer will process the claim within 14 days');
});

test('a trailing "Action, if condition." sentence produces a rule node', async () => {
  const doc = makeDocument([makeUnit({ content: 'The policy is not valid, if any of the information provided is incorrect.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'rule');
  assert.equal(node.action, 'The policy is not valid');
  assert.equal(node.condition, 'any of the information provided is incorrect');
});

// --- Phase 1: paragraph-aware candidate generation (real-document recall fix) ---

test('blank-line-separated rule clauses with no terminal punctuation between them (real burglary-policy.pdf shape) are each recovered as their own node, not fused into one unparseable run-on', async () => {
  // Mirrors the real PDF's "Special Conditions and Exclusions" section: several distinct
  // rule-bearing clauses separated only by a blank line, with no period on any but the last.
  const content = [
    'Warranted that stocks/goods stored in open are excluded from scope of cover under the policy',
    '',
    'Terrorism cover is excluded',
    '',
    'Warranted that there is 24 hours security in the premises.',
  ].join('\n');
  const doc = makeDocument([makeUnit({ content })]);
  const graph = await extractReasoningGraph(doc);
  const kinds = graph.nodes.map((n) => n.nodeType).sort();
  assert.deepEqual(kinds, ['policy', 'policy', 'prohibition']);
  assert.ok(graph.nodes.some((n) => n.action === 'stocks/goods stored in open are excluded from scope of cover under the policy'));
  assert.ok(graph.nodes.some((n) => n.action === 'Terrorism cover is excluded'));
  assert.ok(graph.nodes.some((n) => n.action === 'there is 24 hours security in the premises'));
});

test('without paragraph-aware splitting these same clauses would fuse into a single unmatched run-on (regression guard on the fix itself)', async () => {
  // Same three clauses, but joined with a single space (as if the blank-line
  // boundary were never there) — this must NOT match any pattern, confirming
  // the fix above is really about the blank-line boundary, not something else.
  const content = 'Warranted that stocks/goods stored in open are excluded from scope of cover under the policy Terrorism cover is excluded Warranted that there is 24 hours security in the premises.';
  const doc = makeDocument([makeUnit({ content })]);
  const graph = await extractReasoningGraph(doc);
  // The merged blob still starts with "warranted that ", so it is matched as
  // exactly one (badly-scoped) policy node — this is the failure mode the
  // paragraph-split fix avoids, kept here as a documented before/after contrast.
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]!.nodeType, 'policy');
});


test('determinism: node/edge ids do not depend on unit ordering within the document', async () => {
  const unitA = makeUnit({ id: 'a', content: 'Before signing, KYC verification must be completed.' });
  const unitB = makeUnit({ id: 'b', content: 'Cannot approve a request without identity verification.' });
  const g1 = await extractReasoningGraph(makeDocument([unitA, unitB]));
  const g2 = await extractReasoningGraph(makeDocument([unitB, unitA]));
  assert.deepEqual(
    [...g1.nodes.map((n) => n.id)].sort(),
    [...g2.nodes.map((n) => n.id)].sort(),
  );
});

test('negative case: a unit with no supported pattern contributes no nodes', async () => {
  const doc = makeDocument([makeUnit({ content: 'The weather was pleasant that afternoon.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
});

test('a unit with multiple sentences produces multiple independent candidates', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the payment is late, apply a penalty fee. Cannot waive the fee without manager approval.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.nodes.some((n) => n.nodeType === 'rule'));
  assert.ok(graph.nodes.some((n) => n.nodeType === 'prohibition'));
});

test('confidence is bounded by the unit\'s own confidence — never inflated beyond the source unit\'s stated confidence', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the payment is late, apply a penalty fee.', confidence: 0.4 })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes[0]!.confidence, 0.4);
});

// --- Phase 2: structured semantic expressions flow through end-to-end extraction ---

test('Phase 2: a numeric-comparison decision sentence structures both condition and action end-to-end through extractReasoningGraph', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the claim assessment amount exceeds 10000, then deny the claim.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'decision');
  assert.deepEqual(node.structuredCondition, { type: 'comparison', field: 'the claim assessment amount', operator: '>', value: 10000 });
  assert.deepEqual(node.structuredAction, { type: 'action', action: 'deny', target: 'the claim' });
});

test('Phase 2 real source: the real burglary-policy.pdf "Terrorism cover is excluded" sentence structures as a categorical prohibition', async () => {
  const doc = makeDocument([makeUnit({ content: 'Terrorism cover is excluded.', provenance: { documentPath: 'burglary-policy.pdf', pages: [3], sectionPath: ['Exclusions'], blockProvenance: [], blockIndexRange: [0, 0] } })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0]!;
  assert.equal(node.nodeType, 'prohibition');
  assert.deepEqual(node.structuredCondition, { type: 'categorical', field: 'Terrorism cover', operator: '==', value: 'excluded' });
});

test('Phase 2: a sentence with no supported structured shape still extracts a rule node, just with no structuredCondition/structuredAction', async () => {
  const doc = makeDocument([makeUnit({ content: 'If the customer was treated unfairly, escalate the matter.' })]);
  const graph = await extractReasoningGraph(doc);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]!.structuredCondition, undefined);
});

test('Phase 2 merge: exceptionConditions and structuredExceptions stay in lockstep after two units corroborate the same rule with different exception phrasing', async () => {
  const doc = makeDocument([
    makeUnit({ id: 'u1', content: 'If the order is late, cancel it unless the claim status is approved.' }),
    makeUnit({ id: 'u2', content: 'If the order is late, cancel it unless the customer has a premium subscription.' }),
  ]);
  const graph = await extractReasoningGraph(doc);
  const ruleNode = graph.nodes.find((n) => n.nodeType === 'rule' && n.exceptionConditions.length > 0);
  assert.ok(ruleNode);
  assert.equal(ruleNode!.exceptionConditions.length, 2);
  assert.equal(ruleNode!.structuredExceptions?.length, 2);
  // Every structuredExceptions[i].raw matches exceptionConditions[i], in the same (sorted) order — see merge.ts's doc comment on why this is rebuilt fresh rather than picked from a candidate.
  assert.deepEqual(
    ruleNode!.structuredExceptions?.map((e) => e.raw),
    ruleNode!.exceptionConditions,
  );
  const approvedException = ruleNode!.structuredExceptions?.find((e) => e.raw === 'the claim status is approved');
  assert.deepEqual(approvedException?.condition, { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' });
  const subscriptionException = ruleNode!.structuredExceptions?.find((e) => e.raw === 'the customer has a premium subscription');
  assert.equal(subscriptionException?.condition, undefined); // "premium subscription" is out of the closed categorical vocabulary — correctly left unresolved
});

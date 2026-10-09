import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedKnowledgeExtractor } from '../../src/knowledge/rule-based-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';

function makeUnit(overrides: Partial<ExperienceUnit>): ExperienceUnit {
  return {
    id: 'unit-1' as ExperienceUnit['id'],
    title: 'Untitled',
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

const extractor = new RuleBasedKnowledgeExtractor();

test('produces one unit-primary node mapping semanticType to a knowledge node type', async () => {
  const unit = makeUnit({ semanticType: 'obligation', title: 'Maintain confidentiality', content: 'The Receiving Party shall maintain confidentiality.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary);
  assert.ok(primary);
  assert.equal(primary!.semanticType, 'obligation');
  assert.equal(primary!.localId, 'primary');
});

test('a definition unit uses the detected defined term as its primary label', async () => {
  const unit = makeUnit({ semanticType: 'definition', title: 'Definitions', content: '"Confidential Information" means any non-public data.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.label, 'Confidential Information');
  assert.equal(primary.semanticType, 'definition');
});

test('a definition unit with no detectable term falls back to the unit title', async () => {
  const unit = makeUnit({ semanticType: 'definition', title: 'Fallback Title', content: 'No quoted term appears in this text.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.label, 'Fallback Title');
});

test('a right unit maps to custom:right', async () => {
  const unit = makeUnit({ semanticType: 'right', content: 'The Disclosing Party may terminate at will.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodes.find((n) => n.isUnitPrimary)!.semanticType, 'custom:right');
});

test('extracts organization candidates for capitalized runs ending in a corporate suffix', async () => {
  const unit = makeUnit({ content: 'This Agreement is between Acme Corp and the Client.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const org = result.value.nodes.find((n) => n.label === 'Acme Corp');
  assert.ok(org);
  assert.equal(org!.semanticType, 'organization');
});

test('extracts a plain entity candidate for a capitalized run with no corporate suffix', async () => {
  const unit = makeUnit({ content: 'Please refer all inquiries to Jane Smith directly.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const entity = result.value.nodes.find((n) => n.label === 'Jane Smith');
  assert.ok(entity);
  assert.equal(entity!.semanticType, 'entity');
});

test('produces no edges (relationship-builder.ts owns that centrally)', async () => {
  const unit = makeUnit({ content: 'Acme Corp is mentioned here.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.edges, []);
});

test('every node carries provenance back to the source unit', async () => {
  const unit = makeUnit({ content: 'Acme Corp appears here.', provenance: { documentPath: 'my-doc.pdf', pages: [3], sectionPath: ['Sec A'], blockProvenance: [], blockIndexRange: [0, 0] } });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  for (const node of result.value.nodes) {
    assert.equal(node.provenance.documentPath, 'my-doc.pdf');
    assert.deepEqual(node.provenance.pages, [3]);
    assert.equal(node.provenance.experienceUnitId, unit.id);
  }
});

test('never fails (always returns ok), even for empty content', async () => {
  const unit = makeUnit({ content: '' });
  const result = await extractor.extract(unit);
  assert.equal(result.ok, true);
});

// --- Action/Process realization integration (Stage 4 primary node) ---

test('a general-typed unit with bare imperative content becomes an action primary node', async () => {
  const unit = makeUnit({ semanticType: 'general', title: 'Install the dependency.', content: 'Install the dependency.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'action');
});

test('a general-typed unit with explicit process/composition content becomes a process primary node', async () => {
  const unit = makeUnit({ semanticType: 'general', title: 'The process consists of A, B, and C.', content: 'The process consists of A, B, and C.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'process');
});

test('a general-typed unit with ordinary descriptive content still falls back to concept (no regression)', async () => {
  const unit = makeUnit({ semanticType: 'general', title: 'CRM overview', content: 'CRM (SaaS) manages policy booking and customer data.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'concept');
});

test('an obligation-typed unit is never reclassified as action, even though its content is imperative-shaped', async () => {
  const unit = makeUnit({ semanticType: 'obligation', title: 'Training requirement', content: 'Employees must complete the training within 30 days of hire.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'obligation');
});

test('a definition-typed unit is never reclassified as action', async () => {
  const unit = makeUnit({ semanticType: 'definition', title: 'Definitions', content: '"Confidential Information" means any non-public data disclosed by either party.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'definition');
});

test('a clause-typed list item with bare imperative content becomes action (fallback branch covers clause, not just general)', async () => {
  const unit = makeUnit({ semanticType: 'clause', title: 'Verify the health endpoint.', content: 'Verify the health endpoint.' });
  const result = await extractor.extract(unit);
  assert.ok(result.ok);
  if (!result.ok) return;
  const primary = result.value.nodes.find((n) => n.isUnitPrimary)!;
  assert.equal(primary.semanticType, 'action');
});

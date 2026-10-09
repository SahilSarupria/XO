import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeKnowledgeNodes, type PerUnitExtraction } from '../../src/knowledge/merge.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';

function makeUnit(id: string): ExperienceUnit {
  return {
    id: id as ExperienceUnit['id'],
    title: 'Unit',
    semanticType: 'general',
    content: '',
    provenance: { documentPath: 'doc.pdf', pages: [1], sectionPath: [], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 0, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

function candidate(overrides: Partial<CandidateKnowledgeNode>): CandidateKnowledgeNode {
  return {
    localId: 'x',
    semanticType: 'organization',
    label: 'Acme',
    confidence: 0.6,
    provenance: { experienceUnitId: 'unit-1', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.6 },
    metadata: {},
    isUnitPrimary: false,
    sourceUnitId: 'unit-1',
    ...overrides,
  };
}

test('merges equivalent surface forms into one node with the same id', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'OpenAI', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { nodes: [candidate({ label: 'Open AI', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u3'), extraction: { nodes: [candidate({ label: 'OpenAI Inc.', sourceUnitId: 'u3', localId: 'a' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.nodes.length, 1);
});

test('keeps the most frequent surface form as canonicalLabel and the rest as aliases', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'OpenAI', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { nodes: [candidate({ label: 'OpenAI', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u3'), extraction: { nodes: [candidate({ label: 'Open AI', sourceUnitId: 'u3', localId: 'a' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.canonicalLabel, 'OpenAI');
  assert.deepEqual(result.nodes[0]!.aliases, ['Open AI']);
});

test('does not merge the same label under different semantic types', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'Acme', semanticType: 'organization', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { nodes: [candidate({ label: 'Acme', semanticType: 'concept', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.nodes.length, 2);
});

test('averages confidence across merged candidates', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'Acme', confidence: 0.4, sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { nodes: [candidate({ label: 'Acme', confidence: 0.8, sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.nodes[0]!.confidence, 0.6);
});

test('concatenates provenance from every contributing candidate', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'Acme', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { nodes: [candidate({ label: 'Acme', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.nodes[0]!.provenance.length, 2);
});

test('resolveLocalId maps each candidate back to its merged final node id', () => {
  const perUnit: PerUnitExtraction[] = [{ unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'Acme', sourceUnitId: 'u1', localId: 'primary' })], edges: [] } }];
  const result = mergeKnowledgeNodes(perUnit);
  assert.equal(result.resolveLocalId('u1', 'primary'), result.nodes[0]!.id);
  assert.equal(result.resolveLocalId('u1', 'nonexistent'), undefined);
  assert.equal(result.resolveLocalId('nonexistent-unit', 'primary'), undefined);
});

test('output nodes are sorted by id', () => {
  const perUnit: PerUnitExtraction[] = [
    { unit: makeUnit('u1'), extraction: { nodes: [candidate({ label: 'Zebra', sourceUnitId: 'u1', localId: 'a' }), candidate({ label: 'Apple', sourceUnitId: 'u1', localId: 'b' })], edges: [] } },
  ];
  const result = mergeKnowledgeNodes(perUnit);
  const ids = result.nodes.map((n) => n.id);
  assert.deepEqual([...ids].sort(), ids);
});

test('merging is deterministic regardless of candidate order', () => {
  const a = candidate({ label: 'Acme', sourceUnitId: 'u1', localId: 'a' });
  const b = candidate({ label: 'Acme Corp', sourceUnitId: 'u2', localId: 'a' });
  const resultAB = mergeKnowledgeNodes([{ unit: makeUnit('u1'), extraction: { nodes: [a], edges: [] } }, { unit: makeUnit('u2'), extraction: { nodes: [b], edges: [] } }]);
  const resultBA = mergeKnowledgeNodes([{ unit: makeUnit('u2'), extraction: { nodes: [b], edges: [] } }, { unit: makeUnit('u1'), extraction: { nodes: [a], edges: [] } }]);
  assert.equal(resultAB.nodes[0]!.id, resultBA.nodes[0]!.id);
});

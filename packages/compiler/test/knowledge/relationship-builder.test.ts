import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeEdges } from '../../src/knowledge/relationship-builder.js';
import { mergeKnowledgeNodes, type PerUnitExtraction } from '../../src/knowledge/merge.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceDocument, ExperienceUnit } from '../../src/semantic/types.js';

function makeUnit(id: string, content: string, overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: id as ExperienceUnit['id'],
    title: id,
    semanticType: 'general',
    content,
    provenance: { documentPath: 'doc.pdf', pages: [1], sectionPath: [], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 0, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
    ...overrides,
  };
}

function primaryCandidate(unitId: string, label: string, semanticType: CandidateKnowledgeNode['semanticType'] = 'concept'): CandidateKnowledgeNode {
  return {
    localId: 'primary',
    semanticType,
    label,
    confidence: 0.8,
    provenance: { experienceUnitId: unitId, documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.8 },
    metadata: {},
    isUnitPrimary: true,
    sourceUnitId: unitId,
  };
}

function makeExperienceDocument(units: readonly ExperienceUnit[], relationships: ExperienceDocument['relationshipGraph']['relationships'] = []): ExperienceDocument {
  return { documentPath: 'doc.pdf', documentTitle: undefined, units, relationshipGraph: { relationships } };
}

test('projects a Stage 3 "extends" relationship as a "part_of" knowledge edge', () => {
  const u1 = makeUnit('u1', 'Parent idea');
  const u2 = makeUnit('u2', 'Child idea');
  const doc = makeExperienceDocument([u1, u2], [{ id: 'r1', type: 'extends', fromUnitId: 'u2', toUnitId: 'u1', confidence: 0.7 }]);
  const perUnit: PerUnitExtraction[] = [
    { unit: u1, extraction: { nodes: [primaryCandidate('u1', 'Parent idea')], edges: [] } },
    { unit: u2, extraction: { nodes: [primaryCandidate('u2', 'Child idea')], edges: [] } },
  ];
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.ok(edges.some((e) => e.type === 'part_of'));
});

test('projects Stage 3 "supports" and "defines" relationships with the same type name', () => {
  const u1 = makeUnit('u1', 'A');
  const u2 = makeUnit('u2', 'B');
  const doc = makeExperienceDocument(
    [u1, u2],
    [
      { id: 'r1', type: 'supports', fromUnitId: 'u2', toUnitId: 'u1', confidence: 0.75 },
      { id: 'r2', type: 'defines', fromUnitId: 'u1', toUnitId: 'u2', confidence: 0.8 },
    ],
  );
  const perUnit: PerUnitExtraction[] = [
    { unit: u1, extraction: { nodes: [primaryCandidate('u1', 'A')], edges: [] } },
    { unit: u2, extraction: { nodes: [primaryCandidate('u2', 'B')], edges: [] } },
  ];
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.ok(edges.some((e) => e.type === 'supports'));
  assert.ok(edges.some((e) => e.type === 'defines'));
});

test('resolves extractor-supplied candidate edges from local ids to final node ids', () => {
  const u1 = makeUnit('u1', 'A depends on B');
  const nodeA = primaryCandidate('u1', 'A');
  const nodeB: CandidateKnowledgeNode = { ...primaryCandidate('u1', 'B'), localId: 'other', isUnitPrimary: false };
  const perUnit: PerUnitExtraction[] = [
    {
      unit: u1,
      extraction: {
        nodes: [nodeA, nodeB],
        edges: [{ type: 'depends_on', fromLocalId: 'primary', toLocalId: 'other', confidence: 0.7, provenance: nodeA.provenance }],
      },
    },
  ];
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const doc = makeExperienceDocument([u1]);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.type, 'depends_on');
});

test('creates a content-mention "references" edge when a unit\'s content mentions another node\'s canonical label', () => {
  const u1 = makeUnit('u1', 'This clause discusses Acme Corp directly.');
  const u2 = makeUnit('u2', 'Acme Corp appears again here.');
  const perUnit: PerUnitExtraction[] = [
    { unit: u1, extraction: { nodes: [primaryCandidate('u1', 'Clause about Acme')], edges: [] } },
    { unit: u2, extraction: { nodes: [{ ...primaryCandidate('u2', 'Acme Corp', 'organization'), isUnitPrimary: false, localId: 'entity-0' }], edges: [] } },
  ];
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const doc = makeExperienceDocument([u1, u2]);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.ok(edges.some((e) => e.type === 'references'));
});

test('drops an edge whose endpoint never resolved to a merged node', () => {
  const u1 = makeUnit('u1', 'x');
  const perUnit: PerUnitExtraction[] = [{ unit: u1, extraction: { nodes: [], edges: [] } }]; // no candidates at all -> 'primary' never resolves
  const doc = makeExperienceDocument([u1], [{ id: 'r1', type: 'extends', fromUnitId: 'u1', toUnitId: 'u1', confidence: 0.5 }]);
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.deepEqual(edges, []);
});

test('never produces a self-loop edge', () => {
  const u1 = makeUnit('u1', 'x');
  const perUnit: PerUnitExtraction[] = [{ unit: u1, extraction: { nodes: [primaryCandidate('u1', 'Self')], edges: [] } }];
  const doc = makeExperienceDocument([u1], [{ id: 'r1', type: 'extends', fromUnitId: 'u1', toUnitId: 'u1', confidence: 0.5 }]);
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  assert.deepEqual(edges, []);
});

test('output edges are sorted by id', () => {
  const u1 = makeUnit('u1', 'Mentions Zebra Corp and Apple Corp both.');
  const u2 = makeUnit('u2', 'x', { title: 'x' });
  const perUnit: PerUnitExtraction[] = [
    { unit: u1, extraction: { nodes: [primaryCandidate('u1', 'Intro')], edges: [] } },
    {
      unit: u2,
      extraction: {
        nodes: [
          { ...primaryCandidate('u2', 'Zebra Corp', 'organization'), isUnitPrimary: false, localId: 'e0' },
          { ...primaryCandidate('u2', 'Apple Corp', 'organization'), isUnitPrimary: false, localId: 'e1' },
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeKnowledgeNodes(perUnit);
  const doc = makeExperienceDocument([u1, u2]);
  const edges = buildKnowledgeEdges(doc, perUnit, mergeResult);
  const ids = edges.map((e) => e.id);
  assert.deepEqual([...ids].sort(), ids);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilityRelationships } from '../../src/capabilities/relationship-builder.js';
import { mergeCapabilities, type PerUnitCapabilityExtraction } from '../../src/capabilities/merge.js';
import type { CandidateCapability } from '../../src/capabilities/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';

function makeUnit(id: string, overrides: Partial<{ readonly parentUnitId: string | undefined; readonly blockIndexRange: readonly [number, number]; readonly documentPath: string; readonly listKind: 'ordered' | 'unordered' | undefined }> = {}): ExperienceUnit {
  return {
    id: id as ExperienceUnit['id'],
    title: 'Unit',
    semanticType: 'general',
    content: 'Unit content.',
    provenance: { documentPath: overrides.documentPath ?? 'doc.pdf', pages: [1], sectionPath: [], blockProvenance: [], blockIndexRange: overrides.blockIndexRange ?? [0, 0] },
    hierarchy: { depth: 0, parentUnitId: overrides.parentUnitId as ExperienceUnit['id'] | undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
    ...(overrides.listKind !== undefined ? { listKind: overrides.listKind } : {}),
  };
}

function candidate(overrides: Partial<CandidateCapability>): CandidateCapability {
  return {
    localId: 'x',
    category: 'action',
    name: 'X',
    description: '',
    confidence: 0.6,
    provenance: { experienceUnitId: 'u1', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.6 },
    inputs: [],
    outputs: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
    sourceUnitId: 'u1',
    ...overrides,
  };
}

test('a verb-derived capability extends the same unit\'s title-derived capability', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'title', name: 'Risk Analysis', category: 'analysis', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-0', name: 'Assess Risk', category: 'analysis', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.ok(relationships.some((r) => r.type === 'extends'));
});

test('two non-title capabilities in the same unit complement each other', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'verb-0', name: 'Send Notice', category: 'communication', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-1', name: 'Confirm Receipt', category: 'validation', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.ok(relationships.some((r) => r.type === 'complements'));
});

test('a capability whose description mentions another capability\'s name gets a depends_on edge, reflected in dependencies', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'a', name: 'Send Report', description: 'Requires Draft Report to have been completed first.', sourceUnitId: 'u1' }),
          candidate({ localId: 'b', name: 'Draft Report', description: 'Produces the report document.', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { capabilities, relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.ok(relationships.some((r) => r.type === 'depends_on'));
  const sendReport = capabilities.find((c) => c.canonicalName === 'Send Report')!;
  const draftReport = capabilities.find((c) => c.canonicalName === 'Draft Report')!;
  assert.ok(sendReport.dependencies.includes(draftReport.id));
});

test('resolves extractor-supplied candidate edges from local ids to final capability ids', () => {
  const u1 = makeUnit('u1');
  const capA = candidate({ localId: 'a', name: 'A', sourceUnitId: 'u1' });
  const capB = candidate({ localId: 'b', name: 'B', sourceUnitId: 'u1' });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [capA, capB], edges: [{ type: 'invokes', fromLocalId: 'a', toLocalId: 'b', confidence: 0.7, provenance: capA.provenance }] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  // Both A and B are non-title candidates in the same unit, so the `complements` rule and the
  // within-unit `custom:sequence` rule also legitimately fire between them, in addition to the
  // extractor-supplied `invokes` edge.
  assert.equal(relationships.length, 3);
  assert.ok(relationships.some((r) => r.type === 'invokes'));
  assert.ok(relationships.some((r) => r.type === 'complements'));
  assert.ok(relationships.some((r) => r.type === 'custom:sequence'));
});

test('never produces a self-loop', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [{ unit: u1, extraction: { capabilities: [candidate({ localId: 'title', name: 'Self', sourceUnitId: 'u1' })], edges: [] } }];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.deepEqual(relationships, []);
});

test('output relationships are sorted by id', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'title', name: 'Zebra Process', category: 'workflow', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-0', name: 'Apple Action', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-1', name: 'Mango Action', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const ids = relationships.map((r) => r.id);
  assert.deepEqual([...ids].sort(), ids);
});

// ---------------------------------------------------------------------------
// Sequence Evidence for Workflow Composition
// ---------------------------------------------------------------------------

test('two non-title capabilities in the same unit get a within-unit sequence edge, distinct from complements', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'verb-0', name: 'Match CRM Records', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-1', name: 'Verify Brokerage', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const seq = relationships.find((r) => r.type === 'custom:sequence');
  assert.ok(seq, 'expected a custom:sequence relationship');
  if (!seq) return;
  const match = mergeResult.capabilities.find((c) => c.canonicalName === 'Match CRM Records')!;
  const verify = mergeResult.capabilities.find((c) => c.canonicalName === 'Verify Brokerage')!;
  assert.equal(seq.fromCapabilityId, match.id);
  assert.equal(seq.toCapabilityId, verify.id);
  // Sequence confidence is strictly weaker than complements, which fires on the exact same pair.
  const complements = relationships.find((r) => r.type === 'complements');
  assert.ok(complements);
  if (complements) assert.ok(seq.confidence < complements.confidence);
});

test('cross-unit sequence connects the last capability of one section-mate unit to the first of the next, ordered by blockIndexRange', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Match CRM Records', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Verify Brokerage', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const seq = relationships.find((r) => r.type === 'custom:sequence');
  assert.ok(seq, 'expected a cross-unit custom:sequence relationship');
  if (!seq) return;
  const match = mergeResult.capabilities.find((c) => c.canonicalName === 'Match CRM Records')!;
  const verify = mergeResult.capabilities.find((c) => c.canonicalName === 'Verify Brokerage')!;
  assert.equal(seq.fromCapabilityId, match.id);
  assert.equal(seq.toCapabilityId, verify.id);
});

test('cross-unit sequence orders by blockIndexRange, not by array/perUnit order', () => {
  // u2 (later block) appears first in `perUnit`; the sequence edge must still run u1 -> u2.
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [10, 10] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [30, 30] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Later Step', sourceUnitId: 'u2' })], edges: [] } },
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Earlier Step', sourceUnitId: 'u1' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const seq = relationships.find((r) => r.type === 'custom:sequence');
  assert.ok(seq);
  if (!seq) return;
  const earlier = mergeResult.capabilities.find((c) => c.canonicalName === 'Earlier Step')!;
  const later = mergeResult.capabilities.find((c) => c.canonicalName === 'Later Step')!;
  assert.equal(seq.fromCapabilityId, earlier.id);
  assert.equal(seq.toCapabilityId, later.id);
});

test('cross-unit sequence does NOT connect units in different sections (different parentUnitId)', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-2', blockIndexRange: [4, 4] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Step In Section One', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Step In Section Two', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.equal(relationships.some((r) => r.type === 'custom:sequence'), false);
});

test('cross-unit sequence does NOT connect units in different documents, even with the same parentUnitId string', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2], documentPath: 'doc-a.pdf' });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4], documentPath: 'doc-b.pdf' });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Step In Doc A', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Step In Doc B', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.equal(relationships.some((r) => r.type === 'custom:sequence'), false);
});

test('a unit with only a title capability (no non-title capabilities) does not participate in cross-unit sequencing and is not bridged over', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [1, 1] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [2, 2] }); // title-only: a heading with no real steps
  const u3 = makeUnit('u3', { parentUnitId: 'section-1', blockIndexRange: [3, 3] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'First Step', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'title', name: 'Section Heading', sourceUnitId: 'u2' })], edges: [] } },
    { unit: u3, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Third Step', sourceUnitId: 'u3' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const seqEdges = relationships.filter((r) => r.type === 'custom:sequence');
  const heading = mergeResult.capabilities.find((c) => c.canonicalName === 'Section Heading')!;
  // The title-only unit's capability never appears as either endpoint of a sequence edge.
  assert.equal(seqEdges.some((r) => r.fromCapabilityId === heading.id || r.toCapabilityId === heading.id), false);
  // And First Step / Third Step are NOT bridged directly over the skipped unit either —
  // this module only ever connects direct section-mate adjacency, it does not search past a gap.
  const first = mergeResult.capabilities.find((c) => c.canonicalName === 'First Step')!;
  const third = mergeResult.capabilities.find((c) => c.canonicalName === 'Third Step')!;
  assert.equal(seqEdges.some((r) => r.fromCapabilityId === first.id && r.toCapabilityId === third.id), false);
});

test('unrelated capabilities in the same unit still only get sequence/complements — never requires/depends_on merely from adjacency', () => {
  const u1 = makeUnit('u1');
  const perUnit: PerUnitCapabilityExtraction[] = [
    {
      unit: u1,
      extraction: {
        capabilities: [
          candidate({ localId: 'verb-0', name: 'Unrelated Thing One', sourceUnitId: 'u1' }),
          candidate({ localId: 'verb-1', name: 'Unrelated Thing Two', sourceUnitId: 'u1' }),
        ],
        edges: [],
      },
    },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.equal(relationships.some((r) => r.type === 'requires' || r.type === 'depends_on'), false);
  assert.ok(relationships.some((r) => r.type === 'custom:sequence'));
});

test('a whitespace-only unit (a bare bullet-glyph remnant, no real content) is skipped entirely — it does not break the chain the way a real heading does', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [1, 1] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [2, 2] }); // whitespace-only content, no capability
  const u3 = makeUnit('u3', { parentUnitId: 'section-1', blockIndexRange: [3, 3] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: { ...u1, content: 'Match CRM records vs. Insurer statements.' }, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Match CRM Records', sourceUnitId: 'u1' })], edges: [] } },
    { unit: { ...u2, content: '  ' }, extraction: { capabilities: [], edges: [] } }, // whitespace-only, no capabilities at all
    { unit: { ...u3, content: 'Verify Expected Brokerage.' }, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Verify Brokerage', sourceUnitId: 'u3' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  const seq = relationships.find((r) => r.type === 'custom:sequence');
  const match = mergeResult.capabilities.find((c) => c.canonicalName === 'Match CRM Records')!;
  const verify = mergeResult.capabilities.find((c) => c.canonicalName === 'Verify Brokerage')!;
  assert.ok(seq, 'expected u1 and u3 to be sequenced despite the empty unit between them');
  if (seq) {
    assert.equal(seq.fromCapabilityId, match.id);
    assert.equal(seq.toCapabilityId, verify.id);
  }
});

test('P0.9A area E: cross-unit sequence is NOT asserted between two adjacent bulleted (unordered) sibling units', () => {
  // Models the real Aastha.pdf pattern: bulleted, parallel system descriptions
  // ("CRM (SaaS): ...", "Reconciliation Tool (Bridge): ...") that sit adjacent
  // in the source but are not a procedure — the source's own marker never
  // claimed an order between them.
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2], listKind: 'unordered' });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4], listKind: 'unordered' });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Manage Policy Booking', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Manage Data Normalization', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.equal(relationships.some((r) => r.type === 'custom:sequence'), false);
});

test('P0.9A area E: cross-unit sequence IS still asserted when either adjacent sibling is a numbered (ordered) list item', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2], listKind: 'ordered' });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4], listKind: 'unordered' });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Collect Documents', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Check Policy', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.ok(relationships.some((r) => r.type === 'custom:sequence'));
});

test('P0.9A area E: cross-unit sequence IS still asserted when neither sibling is a list item at all (listKind undefined on both)', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Draft The Notice', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Send The Notice', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult = mergeCapabilities(perUnit);
  const { relationships } = buildCapabilityRelationships(perUnit, mergeResult);
  assert.ok(relationships.some((r) => r.type === 'custom:sequence'));
});

test('sequence evidence is deterministic across repeated calls with the same input', () => {
  const u1 = makeUnit('u1', { parentUnitId: 'section-1', blockIndexRange: [2, 2] });
  const u2 = makeUnit('u2', { parentUnitId: 'section-1', blockIndexRange: [4, 4] });
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: u1, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Match CRM Records', sourceUnitId: 'u1' })], edges: [] } },
    { unit: u2, extraction: { capabilities: [candidate({ localId: 'verb-0', name: 'Verify Brokerage', sourceUnitId: 'u2' })], edges: [] } },
  ];
  const mergeResult1 = mergeCapabilities(perUnit);
  const run1 = buildCapabilityRelationships(perUnit, mergeResult1);
  const mergeResult2 = mergeCapabilities(perUnit);
  const run2 = buildCapabilityRelationships(perUnit, mergeResult2);
  assert.deepEqual(run1.relationships, run2.relationships);
});

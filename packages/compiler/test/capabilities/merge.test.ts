import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCapabilities, type PerUnitCapabilityExtraction } from '../../src/capabilities/merge.js';
import type { CandidateCapability } from '../../src/capabilities/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';

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

function candidate(overrides: Partial<CandidateCapability>): CandidateCapability {
  return {
    localId: 'x',
    category: 'communication',
    name: 'Send Email',
    description: '',
    confidence: 0.6,
    provenance: { experienceUnitId: 'unit-1', documentPath: 'doc.pdf', pages: [1], sectionPath: [], charOffsetRange: undefined, confidence: 0.6 },
    inputs: [],
    outputs: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
    sourceUnitId: 'unit-1',
    ...overrides,
  };
}

test('merges the worked example (Send Email / Email Sending / Mail Sender) into one capability', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Send Email', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { capabilities: [candidate({ name: 'Email Sending', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u3'), extraction: { capabilities: [candidate({ name: 'Mail Sender', sourceUnitId: 'u3', localId: 'a' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  assert.equal(result.capabilities.length, 1);
});

test('keeps the most frequent name as canonicalName and the rest as aliases', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Send Email', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { capabilities: [candidate({ name: 'Send Email', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u3'), extraction: { capabilities: [candidate({ name: 'Mail Sender', sourceUnitId: 'u3', localId: 'a' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  assert.equal(result.capabilities[0]!.canonicalName, 'Send Email');
  assert.deepEqual(result.capabilities[0]!.aliases, ['Mail Sender']);
});

test('does not merge the same name under different categories', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Review', category: 'analysis', sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { capabilities: [candidate({ name: 'Review', category: 'validation', sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  assert.equal(result.capabilities.length, 2);
});

test('unions inputs/outputs/examples/invocationHints across merged candidates', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Send Email', inputs: ['to'], examples: ['ex1'], sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { capabilities: [candidate({ name: 'Send Email', inputs: ['subject'], examples: ['ex2'], sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  assert.deepEqual(result.capabilities[0]!.inputs, ['to', 'subject']);
  assert.deepEqual(result.capabilities[0]!.examples, ['ex1', 'ex2']);
});

test('averages confidence across merged candidates', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Send Email', confidence: 0.4, sourceUnitId: 'u1', localId: 'a' })], edges: [] } },
    { unit: makeUnit('u2'), extraction: { capabilities: [candidate({ name: 'Send Email', confidence: 0.8, sourceUnitId: 'u2', localId: 'a' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  assert.equal(result.capabilities[0]!.confidence, 0.6);
});

test('resolveLocalId maps each candidate back to its merged final capability id', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [{ unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Send Email', sourceUnitId: 'u1', localId: 'primary' })], edges: [] } }];
  const result = mergeCapabilities(perUnit);
  assert.equal(result.resolveLocalId('u1', 'primary'), result.capabilities[0]!.id);
  assert.equal(result.resolveLocalId('u1', 'missing'), undefined);
});

test('dependencies start empty (populated later by relationship-builder.ts)', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [{ unit: makeUnit('u1'), extraction: { capabilities: [candidate({ sourceUnitId: 'u1', localId: 'a' })], edges: [] } }];
  const result = mergeCapabilities(perUnit);
  assert.deepEqual(result.capabilities[0]!.dependencies, []);
});

test('output capabilities are sorted by id', () => {
  const perUnit: PerUnitCapabilityExtraction[] = [
    { unit: makeUnit('u1'), extraction: { capabilities: [candidate({ name: 'Zebra Task', sourceUnitId: 'u1', localId: 'a' }), candidate({ name: 'Apple Task', sourceUnitId: 'u1', localId: 'b' })], edges: [] } },
  ];
  const result = mergeCapabilities(perUnit);
  const ids = result.capabilities.map((c) => c.id);
  assert.deepEqual([...ids].sort(), ids);
});

test('merging is deterministic regardless of candidate order', () => {
  const a = candidate({ name: 'Send Email', sourceUnitId: 'u1', localId: 'a' });
  const b = candidate({ name: 'Email Sending', sourceUnitId: 'u2', localId: 'a' });
  const ab = mergeCapabilities([{ unit: makeUnit('u1'), extraction: { capabilities: [a], edges: [] } }, { unit: makeUnit('u2'), extraction: { capabilities: [b], edges: [] } }]);
  const ba = mergeCapabilities([{ unit: makeUnit('u2'), extraction: { capabilities: [b], edges: [] } }, { unit: makeUnit('u1'), extraction: { capabilities: [a], edges: [] } }]);
  assert.equal(ab.capabilities[0]!.id, ba.capabilities[0]!.id);
});

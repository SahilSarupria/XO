import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExperienceUnitId, computeRelationshipId } from '../../src/semantic/unit-id.js';

test('computeExperienceUnitId is deterministic for identical inputs', () => {
  const a = computeExperienceUnitId('doc.pdf', ['Section 1'], [0, 2], 'some content');
  const b = computeExperienceUnitId('doc.pdf', ['Section 1'], [0, 2], 'some content');
  assert.equal(a, b);
});

test('computeExperienceUnitId changes when content changes', () => {
  const a = computeExperienceUnitId('doc.pdf', ['Section 1'], [0, 2], 'content A');
  const b = computeExperienceUnitId('doc.pdf', ['Section 1'], [0, 2], 'content B');
  assert.notEqual(a, b);
});

test('computeExperienceUnitId changes when sectionPath changes', () => {
  const a = computeExperienceUnitId('doc.pdf', ['Section 1'], [0, 2], 'x');
  const b = computeExperienceUnitId('doc.pdf', ['Section 2'], [0, 2], 'x');
  assert.notEqual(a, b);
});

test('computeExperienceUnitId changes when the document path changes', () => {
  const a = computeExperienceUnitId('doc-a.pdf', ['Section 1'], [0, 2], 'x');
  const b = computeExperienceUnitId('doc-b.pdf', ['Section 1'], [0, 2], 'x');
  assert.notEqual(a, b);
});

test('ids have a stable, readable prefix', () => {
  const id = computeExperienceUnitId('doc.pdf', [], [0, 0], 'x');
  assert.match(id, /^eu_[0-9a-f]{32}$/);
});

test('computeRelationshipId is deterministic and direction-sensitive', () => {
  const a = computeRelationshipId('extends', 'unit-1', 'unit-2');
  const b = computeRelationshipId('extends', 'unit-1', 'unit-2');
  const reversed = computeRelationshipId('extends', 'unit-2', 'unit-1');
  assert.equal(a, b);
  assert.notEqual(a, reversed);
});

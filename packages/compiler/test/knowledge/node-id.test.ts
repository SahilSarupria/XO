import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKnowledgeNodeId, computeKnowledgeEdgeId, computeMatchKey, normalizeForMatching } from '../../src/knowledge/node-id.js';

test('normalizeForMatching lowercases and removes whitespace', () => {
  assert.equal(normalizeForMatching('Open AI'), normalizeForMatching('OpenAI'));
});

test('normalizeForMatching strips a trailing corporate suffix', () => {
  assert.equal(normalizeForMatching('OpenAI Inc.'), normalizeForMatching('OpenAI'));
  assert.equal(normalizeForMatching('Acme LLC'), normalizeForMatching('Acme'));
});

test('normalizeForMatching does not conflate genuinely different labels', () => {
  assert.notEqual(normalizeForMatching('OpenAI'), normalizeForMatching('DeepMind'));
});

test('computeMatchKey includes semantic type, so the same label under different types does not collide', () => {
  const a = computeMatchKey('organization', 'Acme');
  const b = computeMatchKey('concept', 'Acme');
  assert.notEqual(a, b);
});

test('computeKnowledgeNodeId is deterministic and merges equivalent surface forms', () => {
  const a = computeKnowledgeNodeId('organization', 'OpenAI');
  const b = computeKnowledgeNodeId('organization', 'Open AI');
  const c = computeKnowledgeNodeId('organization', 'OpenAI Inc.');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('computeKnowledgeNodeId has a stable, readable prefix', () => {
  const id = computeKnowledgeNodeId('concept', 'x');
  assert.match(id, /^kn_[0-9a-f]{32}$/);
});

test('computeKnowledgeEdgeId is deterministic and direction-sensitive', () => {
  const a = computeKnowledgeEdgeId('references', 'node-1', 'node-2');
  const b = computeKnowledgeEdgeId('references', 'node-1', 'node-2');
  const reversed = computeKnowledgeEdgeId('references', 'node-2', 'node-1');
  assert.equal(a, b);
  assert.notEqual(a, reversed);
});

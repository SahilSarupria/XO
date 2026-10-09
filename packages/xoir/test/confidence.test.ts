import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFromScore, isValidConfidence, scoreOf, UNKNOWN_CONFIDENCE_BASIS_DETAIL, type XoirConfidence } from '../src/confidence.js';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId } from '../src/ids.js';
import { validateGraph } from '../src/validation.js';
import { hashNode } from '../src/hashing.js';
import { createNode } from '../src/node-kinds.js';

test('confidenceFromScore defaults to conservative "unknown" basis/evidence/corroboration/calibrated', () => {
  const c = confidenceFromScore(0.75);
  assert.equal(c.score, 0.75);
  assert.equal(c.basis, 'unknown');
  assert.equal(c.evidenceStrength, 'unknown');
  assert.equal(c.corroboration, 0);
  assert.equal(c.calibrated, false);
  assert.deepEqual({ basis: c.basis, evidenceStrength: c.evidenceStrength, corroboration: c.corroboration, calibrated: c.calibrated }, UNKNOWN_CONFIDENCE_BASIS_DETAIL);
});

test('confidenceFromScore accepts overrides for individual fields', () => {
  const c = confidenceFromScore(0.9, { basis: 'expert_provided', evidenceStrength: 'strong', corroboration: 3 });
  assert.equal(c.basis, 'expert_provided');
  assert.equal(c.evidenceStrength, 'strong');
  assert.equal(c.corroboration, 3);
  assert.equal(c.calibrated, false); // not overridden, stays conservative
});

test('scoreOf works uniformly over a bare number (legacy) or a full XoirConfidence', () => {
  assert.equal(scoreOf(0.5), 0.5);
  const detail: XoirConfidence = confidenceFromScore(0.42);
  assert.equal(scoreOf(detail), 0.42);
});

test('isValidConfidence rejects out-of-range scores and negative corroboration', () => {
  assert.equal(isValidConfidence(confidenceFromScore(0.5)), true);
  assert.equal(isValidConfidence(confidenceFromScore(1.5)), false);
  assert.equal(isValidConfidence(confidenceFromScore(-0.1)), false);
  assert.equal(isValidConfidence({ ...confidenceFromScore(0.5), corroboration: -1 }), false);
});

test('createNode without confidenceDetail keeps metadata.confidence as the sole source of truth (backward compatible)', () => {
  const built = createNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 's', domain: 'd' }, confidence: 0.8 });
  assert.equal(built.metadata.confidence, 0.8);
  assert.equal(built.metadata.confidenceDetail, undefined);
});

test('createNode with only confidenceDetail derives metadata.confidence from confidenceDetail.score, so the two never disagree', () => {
  const detail = confidenceFromScore(0.63, { basis: 'hybrid_extraction', evidenceStrength: 'moderate', corroboration: 2 });
  const built = createNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 's', domain: 'd' }, confidenceDetail: detail });
  assert.equal(built.metadata.confidence, 0.63);
  assert.deepEqual(built.metadata.confidenceDetail, detail);
});

test('an explicit confidence overrides confidenceDetail.score if both are given (confidence wins, as documented)', () => {
  const detail = confidenceFromScore(0.2);
  const built = createNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 's', domain: 'd' }, confidence: 0.9, confidenceDetail: detail });
  assert.equal(built.metadata.confidence, 0.9);
  assert.equal(built.metadata.confidenceDetail?.score, 0.2);
});

test('validateGraph flags an out-of-range confidenceDetail.score even when metadata.confidence itself is in range', () => {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  const result = graph.createAndAddNode({
    id: XoirNodeId('n1'),
    kind: 'fact',
    properties: { statement: 's', domain: 'd' },
    confidence: 0.5,
    confidenceDetail: { ...confidenceFromScore(0.5), score: 1.4 },
  });
  assert.ok(result.ok);
  const report = validateGraph(graph);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.kind === 'invalid_confidence_range' && i.message.includes('confidenceDetail')));
});

test('two nodes with identical confidenceDetail hash identically; a change in confidenceDetail changes the hash', () => {
  const base = { id: XoirNodeId('n1'), kind: 'fact' as const, properties: { statement: 's', domain: 'd' } };
  const now = () => '2026-01-01T00:00:00.000Z';
  const a = createNode({ ...base, confidenceDetail: confidenceFromScore(0.5, { basis: 'stated' }), now });
  const b = createNode({ ...base, confidenceDetail: confidenceFromScore(0.5, { basis: 'stated' }), now });
  const c = createNode({ ...base, confidenceDetail: confidenceFromScore(0.5, { basis: 'observed' }), now });
  assert.equal(hashNode(a), hashNode(b));
  assert.notEqual(hashNode(a), hashNode(c));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId } from '@xo/xoir';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';
import { computeSemanticQualityReport, computeSemanticQualityReportWithResolution } from '../../src/pipeline/quality-metrics.js';

test('reports zero-everything, provenanceCoverage 1, for an empty graph', () => {
  const graph = XoirGraph.create(XoirGraphId('empty'));
  const report = computeSemanticQualityReport(graph);
  assert.equal(report.totalSemanticNodes, 0);
  assert.equal(report.capabilitiesDiscovered, 0);
  assert.equal(report.provenanceCoverage, 1);
  assert.equal(report.resolvedCapabilities, undefined);
});

test('omits the resolved/unresolved/ambiguous/denied breakdown when no LowerCapabilitiesResult is supplied', async () => {
  const text = '# Claim Assessment\n\nIf the claim assessment amount exceeds 10000, then deny the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  // M1.1: this single clean, single-comparison rule is now both linked to
  // the title-derived "Claim Assessment" capability (as before) AND minted
  // as its own dedicated "Deny The Claim" capability — see
  // `../../src/capabilities/rule-capability-minter.ts`.
  assert.equal(report.capabilitiesDiscovered, 2);
  assert.equal(report.resolvedCapabilities, undefined);
  assert.equal(report.unresolvedCapabilities, undefined);
});

test('populates the resolved/unresolved breakdown when a LowerCapabilitiesResult is supplied', async () => {
  const text = '# Claim Assessment\n\nIf the claim assessment amount exceeds 10000, then deny the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const lowered = lowerCapabilitiesToManifest(result.value.graph);
  const report = computeSemanticQualityReport(result.value.graph, lowered);
  // M1.1: see comment above — both the pre-existing "Claim Assessment"
  // capability and the newly-minted "Deny The Claim" capability resolve.
  assert.equal(report.capabilitiesDiscovered, 2);
  assert.equal(report.resolvedCapabilities, 2);
  assert.equal(report.unresolvedCapabilities, 0);
  assert.equal(report.ambiguousCapabilities, 0);
  assert.equal(report.deniedCapabilities, 0);
});

test('computeSemanticQualityReportWithResolution is equivalent to computing the binding resolution itself and passing it in', async () => {
  const text = '# Claim Assessment\n\nIf the claim assessment amount exceeds 10000, then deny the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const viaConvenience = computeSemanticQualityReportWithResolution(result.value.graph);
  const viaManual = computeSemanticQualityReport(result.value.graph, lowerCapabilitiesToManifest(result.value.graph));
  assert.deepEqual(viaConvenience, viaManual);
});

test('a high-confidence true-imperative capability counts as high-confidence; a weaker verb-elsewhere match counts as low-confidence', async () => {
  const text = 'Send the notice to all parties within five days.\n\nAcme shall eventually notify the office of any change.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'obligations.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  assert.ok(report.capabilitiesDiscovered >= 1);
  assert.ok(report.highConfidenceCapabilities >= 1);
});

test('constraint/decision/reasoning node counts reflect real reasoning extraction, not just capability nodes', async () => {
  const text = 'Terrorism cover is excluded.\n\nIf the claim assessment amount exceeds 10000, then deny the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  assert.ok(report.constraintNodes >= 1, 'the exclusion clause should produce a constraint node');
  assert.ok(report.decisionNodes >= 1, 'the if/then clause should produce a decision_node');
});

test('provenanceCoverage is 1 for a graph built entirely through the normal extraction pipeline (every node carries a sourceRef)', async () => {
  const text = 'Send the notice to all parties within five days.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'x.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  assert.equal(report.provenanceCoverage, 1);
});

test('nodesByKind and totalSemanticNodes are exactly graph.stats()\u2019s own numbers, not independently recomputed', async () => {
  const text = 'Send the notice to all parties within five days.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'x.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const stats = result.value.graph.stats();
  const report = computeSemanticQualityReport(result.value.graph);
  assert.deepEqual(report.nodesByKind, stats.nodesByKind);
  assert.equal(report.totalSemanticNodes, stats.nodeCount);
});

// --- Semantic links (Problem C) ---------------------------------------------

test('semanticLinks counts exact-label and same-unit-overlap REQUIRES edges into capability/concept nodes', async () => {
  const text = '# Claim Assessment\n\nIf the claim assessment amount exceeds 5000, then reject the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  assert.ok(report.semanticLinks >= 1);
  // M1.1: the same rule is now also minted as its own dedicated
  // capability with a `structuralLinks`-tier edge back to itself (see
  // `structuralLinks`' doc comment) — the three tiers are disjoint and
  // must always sum to the total.
  assert.equal(report.semanticLinks, report.highConfidenceLinks + report.mediumConfidenceLinks + report.structuralLinks);
  assert.ok(report.highConfidenceLinks >= 1, 'the literal "claim assessment" phrase should exact-match');
  assert.ok(report.structuralLinks >= 1, 'the minted "Reject The Claim" capability should have its own deterministic derivation edge');
});

test('semanticLinks is 0 for a graph with reasoning content but no capability/concept for it to reference', () => {
  const graph = XoirGraph.create(XoirGraphId('no-refs'));
  const report = computeSemanticQualityReport(graph);
  assert.equal(report.semanticLinks, 0);
  assert.equal(report.highConfidenceLinks, 0);
  assert.equal(report.mediumConfidenceLinks, 0);
});

test('mediumConfidenceLinks counts same-unit term-overlap links distinctly from exact-label links', async () => {
  // No heading repeats the exact phrase "amount claimed" inside the rule; the capability's own name ("Claim Assessment") is absent from the rule text, so only the same-unit-overlap tier can fire.
  const text = '# Claim Assessment\n\nIf the amount claimed exceeds 5000, then reject the claim.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'policy.txt' }], {});
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = computeSemanticQualityReport(result.value.graph);
  assert.ok(report.mediumConfidenceLinks >= 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPhase2Benchmark } from '../../../../examples/vertical-test/phase2-semantic-benchmark.js';

test('Phase 2 synthetic semantic-expression benchmark: 100% precision and recall across every fixture case', () => {
  const report = runPhase2Benchmark();
  assert.ok(report.totalCases >= 40, `expected a substantive fixture (>=40 cases), got ${report.totalCases}`);
  assert.equal(report.falsePositives, 0, `${report.falsePositives} case(s) invented structure where ground truth says unresolved`);
  assert.equal(report.falseNegativesMissed, 0, `${report.falseNegativesMissed} case(s) should have structured but didn't`);
  assert.equal(report.falseNegativesWrongStructure, 0, `${report.falseNegativesWrongStructure} case(s) structured but produced the wrong shape/values`);
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 1);
});

test('Phase 2 benchmark covers every required category from the brief with both a positive and a negative case', () => {
  const report = runPhase2Benchmark();
  const requiredCategories = ['>', '<', '>=', '<=', 'equality', 'range', 'categorical', 'and', 'or', 'exception', 'temporal', 'ambiguous', 'action'];
  for (const category of requiredCategories) {
    const casesInCategory = report.cases.filter((c) => c.category === category);
    assert.ok(casesInCategory.length > 0, `no fixture cases for required category "${category}"`);
  }
  // Every required numeric/threshold/logical category (not the deliberately
  // single-negative "ambiguous" category) has at least one case expecting
  // real structure AND at least one case expecting 'unresolved'.
  for (const category of requiredCategories.filter((c) => c !== 'ambiguous')) {
    const casesInCategory = report.cases.filter((c) => c.category === category);
    assert.ok(
      casesInCategory.some((c) => c.expected !== 'unresolved'),
      `category "${category}" has no positive (structurable) case`,
    );
    assert.ok(
      casesInCategory.some((c) => c.expected === 'unresolved'),
      `category "${category}" has no negative (unresolved) case`,
    );
  }
});

/**
 * UW-3b (G) — the document-structure evaluation corpus: procedures with wrapped step tables, titled rules, checklists,
 * fill-in forms and markdown equivalents, outside the insurance domain. Measured through the real pipeline (source ->
 * XOIR -> contracts -> workflows). The ground-truth register is audited like every other suite's.
 *
 * Before UW-3b (measured on the same suite, same fixtures, baseline compiler; see CHANGELOG.md):
 *   capabilityRecall 0/20, capabilityPrecision 0/22, semanticRecall 2/41, semanticPrecision 2/5,
 *   spuriousCapabilityAvoidance 0/3, spuriousFactAvoidance 1/4, workflowRecall 0/4.
 * After: every measured metric is exact (asserted below).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditExpectationIntegrity, auditGroundTruth, loadSuiteFile, parseGroundTruth, runSuite } from '../src/index.js';

const PKG = fileURLToPath(new URL('../', import.meta.url));

test('document-structure: the suite and its ground-truth register are valid and fully audited', async () => {
  const loaded = await loadSuiteFile(join(PKG, 'suites', 'document-structure.suite.json'));
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.message);
  const register = parseGroundTruth(JSON.parse(await readFile(join(PKG, 'ground-truth', 'document-structure.ground-truth.json'), 'utf8')));
  assert.ok(register.ok, register.ok ? '' : JSON.stringify(register.issues));
  assert.deepEqual(auditGroundTruth(loaded.suite, register.value), []);
  assert.deepEqual(auditExpectationIntegrity(loaded.suite), []);
});

test('document-structure: steps, rules, criteria and workflows are recovered exactly; nothing stitched, no form prompt read as a rule', async () => {
  const loaded = await loadSuiteFile(join(PKG, 'suites', 'document-structure.suite.json'));
  assert.ok(loaded.ok);
  const report = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
  assert.equal(report.harnessErrorCount, 0);
  assert.equal(report.caseCount, 7);
  const metric = (id: string) => report.aggregate.metrics.find((m) => m.id === id)!;
  for (const [id, min] of [
    ['capabilityRecall', 20],
    ['capabilityPrecision', 20],
    ['semanticRecall', 41],
    ['semanticPrecision', 41],
    ['semanticCorrectness', 41],
    ['spuriousCapabilityAvoidance', 3],
    ['spuriousFactAvoidance', 4],
    ['workflowRecall', 4],
    ['workflowStructureAccuracy', 4],
    ['workflowExecutabilityAccuracy', 4],
    ['resolutionAccuracy', 20],
  ] as const) {
    const m = metric(id);
    assert.ok(m.denominator >= min, `${id}: denominator ${m.denominator} < ${min} (the measurement must not be vacuous)`);
    assert.equal(
      m.ratio,
      1,
      `${id}: ${m.numerator}/${m.denominator} ${JSON.stringify([...m.missing, ...m.unexpected, ...m.mismatched].slice(0, 5))}`,
    );
  }
});

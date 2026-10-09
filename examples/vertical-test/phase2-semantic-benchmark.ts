/**
 * Phase 2 synthetic semantic-expression benchmark runner.
 *
 * Runs `phase2-semantic-fixture.ts`'s ground-truth-labeled cases through
 * `@xo/capability-contract`'s `parseStructuredCondition`/
 * `parseStructuredAction` and scores the result. Mirrors
 * `run.ts`'s convention of writing a JSON report to `output/`.
 *
 *   node --import tsx examples/vertical-test/phase2-semantic-benchmark.ts
 */

import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseStructuredAction, parseStructuredCondition } from '@xo/capability-contract';
import { ACTION_FIXTURE, CONDITION_FIXTURE, type ActionFixtureCase, type ConditionFixtureCase, type FixtureActionExpected, type FixtureExpected } from './phase2-semantic-fixture.js';

interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly text: string;
  readonly expected: FixtureExpected | FixtureActionExpected;
  readonly actual: FixtureExpected | FixtureActionExpected;
  readonly outcome: 'true_positive' | 'true_negative' | 'false_positive' | 'false_negative_wrong_structure' | 'false_negative_missed';
}

function deepEqualSafe(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function scoreCase(id: string, category: string, text: string, expected: FixtureExpected | FixtureActionExpected, actual: FixtureExpected | FixtureActionExpected): CaseResult {
  const expectedUnresolved = expected === 'unresolved';
  const actualUnresolved = actual === 'unresolved';

  let outcome: CaseResult['outcome'];
  if (expectedUnresolved && actualUnresolved) {
    outcome = 'true_negative'; // correctly refused to structure
  } else if (!expectedUnresolved && !actualUnresolved && deepEqualSafe(expected, actual)) {
    outcome = 'true_positive'; // correctly structured, and structured correctly
  } else if (expectedUnresolved && !actualUnresolved) {
    outcome = 'false_positive'; // invented structure where none should exist
  } else if (!expectedUnresolved && actualUnresolved) {
    outcome = 'false_negative_missed'; // should have structured, didn't (recall miss)
  } else {
    outcome = 'false_negative_wrong_structure'; // structured, but wrong shape/values (precision miss)
  }

  return { id, category, text, expected, actual, outcome };
}

function runConditionCase(c: ConditionFixtureCase): CaseResult {
  const actual = parseStructuredCondition(c.text) ?? 'unresolved';
  return scoreCase(c.id, c.category, c.text, c.expected, actual);
}

function runActionCase(c: ActionFixtureCase): CaseResult {
  const actual = parseStructuredAction(c.text) ?? 'unresolved';
  return scoreCase(c.id, c.category, c.text, c.expected, actual);
}

export interface BenchmarkReport {
  readonly totalCases: number;
  readonly truePositives: number;
  readonly trueNegatives: number;
  readonly falsePositives: number;
  readonly falseNegativesMissed: number;
  readonly falseNegativesWrongStructure: number;
  /** correctly-structured / everything the grammar DID structure (true_positive + false_positive + wrong_structure) */
  readonly precision: number;
  /** correctly-structured / everything ground truth says SHOULD structure (true_positive + false_negative_missed + wrong_structure) */
  readonly recall: number;
  readonly byCategory: Readonly<Record<string, { readonly total: number; readonly correct: number }>>;
  readonly cases: readonly CaseResult[];
}

export function runPhase2Benchmark(): BenchmarkReport {
  const results: CaseResult[] = [...CONDITION_FIXTURE.map(runConditionCase), ...ACTION_FIXTURE.map(runActionCase)];

  const truePositives = results.filter((r) => r.outcome === 'true_positive').length;
  const trueNegatives = results.filter((r) => r.outcome === 'true_negative').length;
  const falsePositives = results.filter((r) => r.outcome === 'false_positive').length;
  const falseNegativesMissed = results.filter((r) => r.outcome === 'false_negative_missed').length;
  const falseNegativesWrongStructure = results.filter((r) => r.outcome === 'false_negative_wrong_structure').length;

  const structuredTotal = truePositives + falsePositives + falseNegativesWrongStructure;
  const shouldStructureTotal = truePositives + falseNegativesMissed + falseNegativesWrongStructure;
  const precision = structuredTotal === 0 ? 1 : truePositives / structuredTotal;
  const recall = shouldStructureTotal === 0 ? 1 : truePositives / shouldStructureTotal;

  const byCategory: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    const bucket = byCategory[r.category] ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (r.outcome === 'true_positive' || r.outcome === 'true_negative') bucket.correct += 1;
    byCategory[r.category] = bucket;
  }

  return {
    totalCases: results.length,
    truePositives,
    trueNegatives,
    falsePositives,
    falseNegativesMissed,
    falseNegativesWrongStructure,
    precision,
    recall,
    byCategory,
    cases: results,
  };
}

async function main() {
  const report = runPhase2Benchmark();
  console.log(`Phase 2 semantic-expression benchmark: ${report.totalCases} cases`);
  console.log(`  true positives (correctly structured):      ${report.truePositives}`);
  console.log(`  true negatives (correctly left unresolved):  ${report.trueNegatives}`);
  console.log(`  false positives (wrongly invented structure):${report.falsePositives}`);
  console.log(`  false negatives (missed, should structure):  ${report.falseNegativesMissed}`);
  console.log(`  false negatives (structured, but wrong):     ${report.falseNegativesWrongStructure}`);
  console.log(`  precision: ${(report.precision * 100).toFixed(1)}%`);
  console.log(`  recall:    ${(report.recall * 100).toFixed(1)}%`);
  console.log('  by category:');
  for (const [category, { total, correct }] of Object.entries(report.byCategory)) {
    console.log(`    ${category}: ${correct}/${total}`);
  }
  const failing = report.cases.filter((c) => c.outcome === 'false_positive' || c.outcome === 'false_negative_missed' || c.outcome === 'false_negative_wrong_structure');
  if (failing.length > 0) {
    console.log('  failing cases:');
    for (const c of failing) console.log(`    [${c.id}] "${c.text}" — ${c.outcome} — expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
  }

  await mkdir('output', { recursive: true });
  await writeFile('output/phase2-semantic-benchmark-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('Report written to output/phase2-semantic-benchmark-report.json');

  if (failing.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

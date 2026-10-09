"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPhase2Benchmark = runPhase2Benchmark;
const promises_1 = require("node:fs/promises");
const strict_1 = __importDefault(require("node:assert/strict"));
const capability_contract_1 = require("@xo/capability-contract");
const phase2_semantic_fixture_js_1 = require("./phase2-semantic-fixture.js");
function deepEqualSafe(a, b) {
    try {
        strict_1.default.deepStrictEqual(a, b);
        return true;
    }
    catch {
        return false;
    }
}
function scoreCase(id, category, text, expected, actual) {
    const expectedUnresolved = expected === 'unresolved';
    const actualUnresolved = actual === 'unresolved';
    let outcome;
    if (expectedUnresolved && actualUnresolved) {
        outcome = 'true_negative'; // correctly refused to structure
    }
    else if (!expectedUnresolved && !actualUnresolved && deepEqualSafe(expected, actual)) {
        outcome = 'true_positive'; // correctly structured, and structured correctly
    }
    else if (expectedUnresolved && !actualUnresolved) {
        outcome = 'false_positive'; // invented structure where none should exist
    }
    else if (!expectedUnresolved && actualUnresolved) {
        outcome = 'false_negative_missed'; // should have structured, didn't (recall miss)
    }
    else {
        outcome = 'false_negative_wrong_structure'; // structured, but wrong shape/values (precision miss)
    }
    return { id, category, text, expected, actual, outcome };
}
function runConditionCase(c) {
    const actual = (0, capability_contract_1.parseStructuredCondition)(c.text) ?? 'unresolved';
    return scoreCase(c.id, c.category, c.text, c.expected, actual);
}
function runActionCase(c) {
    const actual = (0, capability_contract_1.parseStructuredAction)(c.text) ?? 'unresolved';
    return scoreCase(c.id, c.category, c.text, c.expected, actual);
}
function runPhase2Benchmark() {
    const results = [...phase2_semantic_fixture_js_1.CONDITION_FIXTURE.map(runConditionCase), ...phase2_semantic_fixture_js_1.ACTION_FIXTURE.map(runActionCase)];
    const truePositives = results.filter((r) => r.outcome === 'true_positive').length;
    const trueNegatives = results.filter((r) => r.outcome === 'true_negative').length;
    const falsePositives = results.filter((r) => r.outcome === 'false_positive').length;
    const falseNegativesMissed = results.filter((r) => r.outcome === 'false_negative_missed').length;
    const falseNegativesWrongStructure = results.filter((r) => r.outcome === 'false_negative_wrong_structure').length;
    const structuredTotal = truePositives + falsePositives + falseNegativesWrongStructure;
    const shouldStructureTotal = truePositives + falseNegativesMissed + falseNegativesWrongStructure;
    const precision = structuredTotal === 0 ? 1 : truePositives / structuredTotal;
    const recall = shouldStructureTotal === 0 ? 1 : truePositives / shouldStructureTotal;
    const byCategory = {};
    for (const r of results) {
        const bucket = byCategory[r.category] ?? { total: 0, correct: 0 };
        bucket.total += 1;
        if (r.outcome === 'true_positive' || r.outcome === 'true_negative')
            bucket.correct += 1;
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
        for (const c of failing)
            console.log(`    [${c.id}] "${c.text}" — ${c.outcome} — expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
    }
    await (0, promises_1.mkdir)('output', { recursive: true });
    await (0, promises_1.writeFile)('output/phase2-semantic-benchmark-report.json', JSON.stringify(report, null, 2), 'utf8');
    console.log('Report written to output/phase2-semantic-benchmark-report.json');
    if (failing.length > 0)
        process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
//# sourceMappingURL=phase2-semantic-benchmark.js.map
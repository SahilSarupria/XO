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
import { type FixtureActionExpected, type FixtureExpected } from './phase2-semantic-fixture.js';
interface CaseResult {
    readonly id: string;
    readonly category: string;
    readonly text: string;
    readonly expected: FixtureExpected | FixtureActionExpected;
    readonly actual: FixtureExpected | FixtureActionExpected;
    readonly outcome: 'true_positive' | 'true_negative' | 'false_positive' | 'false_negative_wrong_structure' | 'false_negative_missed';
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
    readonly byCategory: Readonly<Record<string, {
        readonly total: number;
        readonly correct: number;
    }>>;
    readonly cases: readonly CaseResult[];
}
export declare function runPhase2Benchmark(): BenchmarkReport;
export {};
//# sourceMappingURL=phase2-semantic-benchmark.d.ts.map
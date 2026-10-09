/**
 * Phase 2 deterministic synthetic semantic-expression benchmark fixture.
 *
 * Every case pairs a source text with a KNOWN ground-truth outcome —
 * either an exact expected `StructuredCondition`/`StructuredAction`, or
 * the literal string `'unresolved'` for a case this grammar must
 * deliberately refuse to structure. Both are first-class expected
 * outcomes: a `'unresolved'` case that the grammar structures anyway is
 * just as much a benchmark failure as a structurable case the grammar
 * misses — see `phase2-semantic-benchmark.test.ts` and
 * `phase2-semantic-benchmark.ts` for how this fixture is scored
 * (precision over cases the grammar DID structure, recall over cases
 * ground truth says SHOULD structure).
 *
 * Categories covered, each with at least one positive and one negative
 * case, per the Phase 2 brief's "SYNTHETIC PHASE 2 BENCHMARK" section:
 * >, <, >=, <=, equality, thresholds, ranges, AND, OR, exceptions,
 * supported temporal expressions, plus ambiguous/ out-of-vocabulary
 * negative cases the compiler must refuse to invent structure for.
 */
import type { StructuredAction, StructuredCondition } from '@xo/capability-contract';
export type FixtureExpected = StructuredCondition | 'unresolved';
export type FixtureActionExpected = StructuredAction | 'unresolved';
export interface ConditionFixtureCase {
    readonly id: string;
    readonly category: string;
    readonly text: string;
    readonly expected: FixtureExpected;
}
export interface ActionFixtureCase {
    readonly id: string;
    readonly category: string;
    readonly text: string;
    readonly expected: FixtureActionExpected;
}
export declare const CONDITION_FIXTURE: readonly ConditionFixtureCase[];
export declare const ACTION_FIXTURE: readonly ActionFixtureCase[];
//# sourceMappingURL=phase2-semantic-fixture.d.ts.map
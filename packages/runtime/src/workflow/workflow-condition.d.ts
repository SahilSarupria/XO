import type { WorkflowCondition } from './workflow-graph.js';
/** Resolves a `.`-separated dot-path (e.g. `"reviewResult.risk"`) against a plain outputs record. Missing segments resolve to `undefined`, never throw. */
export declare function resolvePath(outputs: Readonly<Record<string, unknown>>, path: string): unknown;
/**
 * Evaluates a `WorkflowCondition` against `outputs` — pure and
 * deterministic for the `'expression'` form (dot-path lookup + a fixed
 * comparison table); the `'predicate'` form defers to the caller's own
 * function, which is only as deterministic as that function is (see its
 * own doc comment in `workflow-graph.ts` for why it's not something a
 * compiler-produced graph should ever use).
 */
export declare function evaluateCondition(condition: WorkflowCondition, outputs: Readonly<Record<string, unknown>>): boolean;
//# sourceMappingURL=workflow-condition.d.ts.map
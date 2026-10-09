import type { WorkflowCondition } from './workflow-graph.js';

/** Resolves a `.`-separated dot-path (e.g. `"reviewResult.risk"`) against a plain outputs record. Missing segments resolve to `undefined`, never throw. */
export function resolvePath(outputs: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = outputs;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Evaluates a `WorkflowCondition` against `outputs` — pure and
 * deterministic for the `'expression'` form (dot-path lookup + a fixed
 * comparison table); the `'predicate'` form defers to the caller's own
 * function, which is only as deterministic as that function is (see its
 * own doc comment in `workflow-graph.ts` for why it's not something a
 * compiler-produced graph should ever use).
 */
export function evaluateCondition(condition: WorkflowCondition, outputs: Readonly<Record<string, unknown>>): boolean {
  if (condition.kind === 'predicate') return condition.evaluate(outputs);

  const actual = resolvePath(outputs, condition.field);
  switch (condition.operator) {
    case 'exists':
      return actual !== undefined;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'gte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'lte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
  }
}

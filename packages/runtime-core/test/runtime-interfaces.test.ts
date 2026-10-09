import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Budgeter, Merger, RetrievedSlice, SafetyChecker } from '../src/runtime.interface.js';

/** Contract tests: confirm the runtime interfaces are shaped in a way real implementations can satisfy. No runtime implementation is provided. */

const slice = (kind: string, tokens: number): RetrievedSlice => ({ componentKind: kind, content: 'x'.repeat(tokens), estimatedTokens: tokens });

class FakeBudgeter implements Budgeter {
  fit(slices: readonly RetrievedSlice[], tokenBudget: number): readonly RetrievedSlice[] {
    const result: RetrievedSlice[] = [];
    let used = 0;
    for (const s of slices) {
      if (used + s.estimatedTokens > tokenBudget) break;
      result.push(s);
      used += s.estimatedTokens;
    }
    return result;
  }
}

class FakeMerger implements Merger {
  merge(sliceLists: readonly RetrievedSlice[][]): readonly RetrievedSlice[] {
    return sliceLists.flat();
  }
}

class FakeSafetyChecker implements SafetyChecker {
  check(): ReturnType<SafetyChecker['check']> {
    return { verdict: 'allow' };
  }
}

test('Budgeter.fit stops adding slices once the token budget is exceeded', () => {
  const budgeter = new FakeBudgeter();
  const fitted = budgeter.fit([slice('a', 50), slice('b', 60)], 100);
  assert.equal(fitted.length, 1);
  assert.equal(fitted[0]?.componentKind, 'a');
});

test('Merger.merge flattens multiple packages worth of slices', () => {
  const merger = new FakeMerger();
  const merged = merger.merge([[slice('a', 1)], [slice('b', 1)]]);
  assert.equal(merged.length, 2);
});

test('SafetyChecker.check returns a verdict', () => {
  const checker = new FakeSafetyChecker();
  assert.equal(checker.check().verdict, 'allow');
});

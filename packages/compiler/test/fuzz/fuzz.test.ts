import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzLoader, fuzzParsers } from './pdf-fuzz.js';

// Fixed seed and a modest iteration count keep CI deterministic and fast; `scripts/fuzz-pdf.mts` runs the long version.
test('fuzz: mutated PDFs never throw, hang or change result between runs (fixed seed)', { timeout: 300_000 }, () => {
  const failures = fuzzLoader(20261030, 600);
  assert.deepEqual(failures, []);
});

test('fuzz: random bytes through every filter and the content-stream parser stay contained (fixed seed)', { timeout: 120_000 }, () => {
  assert.deepEqual(fuzzParsers(20261031, 3000), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const PDF = fileURLToPath(new URL('../../../../examples/insurance-dev-corpus/pdfs/property_schedule_tables.pdf', import.meta.url));

test('WS1-03: the rows of a schedule table, including a two-column grid, become header-bound constraint nodes, never executable rules (synthetic corpus)', async () => {
  const bytes = new Uint8Array(readFileSync(PDF));
  const result = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'property_schedule_tables.pdf' }]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  const constraints = result.value.graph
    .allNodes()
    .filter((n) => n.kind === 'constraint')
    .map((n) => JSON.stringify(n.properties));
  for (const expected of [
    'Coverage: Buildings; Limit: 1000000; Excess: 1000',
    'Coverage: Contents; Limit: 250000; Excess: 500',
    'Coverage: Business interruption; Limit: 500000; Excess: 7 days',
    'Coverage: Theft; Limit: 50000; Excess: 2500',
    'Cover: Flood; Waiting period: 14 days',
    'Cover: Subsidence; Waiting period: 60 days',
  ]) {
    assert.ok(
      constraints.some((c) => c.includes(expected)),
      `missing table-row constraint: ${expected}`,
    );
  }
  // A table row is a recorded term, not a rule: it never becomes a decision node or an executable capability by itself.
  assert.equal(
    result.value.graph.allNodes().filter((n) => n.kind === 'decision_node' && JSON.stringify(n.properties).includes('1000000')).length,
    0,
  );
});

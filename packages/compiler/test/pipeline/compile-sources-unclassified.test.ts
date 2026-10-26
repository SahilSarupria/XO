import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const TEXT = `# Claims Handling
Claims must be reported within 30 days of the loss event.

The handler shall register each claim within 1 working day of receipt.

The insurer shall acknowledge each claim within 5 business days.

This claim form has 3 pages.

The insurer shall settle each undisputed claim within 30 days of the final document.`;

test('WS1-04: decision-bearing sentences no rule pattern parsed are reported with their source span, in document order', async () => {
  const result = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  const texts = result.value.unclassified.map((u) => u.text);
  assert.deepEqual(texts, [
    'The handler shall register each claim within 1 working day of receipt.',
    'The insurer shall acknowledge each claim within 5 business days.',
    'The insurer shall settle each undisputed claim within 30 days of the final document.',
  ]);
  for (const item of result.value.unclassified) {
    assert.ok(item.cues.length > 0);
    assert.ok(item.provenance.charOffsetRange !== undefined, 'every item carries its source span');
    assert.ok(item.sourceUnitId.length > 0);
  }
});

test('a sentence the patterns DID parse is not in the unclassified list, and plain description is not either', async () => {
  const result = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  assert.ok(result.ok);
  if (!result.ok) return;
  const texts = result.value.unclassified.map((u) => u.text);
  assert.ok(!texts.some((t) => t.startsWith('Claims must be reported')));
  assert.ok(!texts.some((t) => t.includes('3 pages')));
});

test('unclassified sentences never become reasoning nodes: the review list is not a rule list', async () => {
  const result = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  assert.ok(result.ok);
  if (!result.ok) return;
  // Reasoning extraction maps to heuristic / decision_node. The knowledge and capability extractors
  // run independently over the same text and may legitimately produce concept/constraint nodes from
  // these sentences; that is existing behaviour and not what this list controls.
  const reasoningText = result.value.graph
    .allNodes()
    .filter((n) => n.kind === 'heuristic' || n.kind === 'decision_node')
    .map((n) => JSON.stringify(n.properties))
    .join('\n');
  assert.ok(!reasoningText.includes('deductible for water damage'));
  assert.ok(!reasoningText.includes('acknowledge each claim'));
  assert.ok(!reasoningText.includes('maximum of $250,000'));
});

test('a summary diagnostic reports the count; none is emitted when nothing is unclassified', async () => {
  const withMisses = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  assert.ok(withMisses.ok);
  if (!withMisses.ok) return;
  const diag = withMisses.value.diagnostics.find((d) => d.code === 'reasoning/unclassified-decision-sentences');
  assert.ok(diag);
  assert.equal(diag!.severity, 'info');
  assert.match(diag!.message, /^3 sentence\(s\)/);

  const clean = await compileSources([
    { kind: 'document', text: '# Claims\nClaims must be reported within 30 days of the loss event.', sourcePath: 'c.txt' },
  ]);
  assert.ok(clean.ok);
  if (!clean.ok) return;
  assert.deepEqual(clean.value.unclassified, []);
  assert.ok(!clean.value.diagnostics.some((d) => d.code === 'reasoning/unclassified-decision-sentences'));
});

test('the list is deterministic across runs', async () => {
  const a = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  const b = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'claims.txt' }]);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.value.unclassified, b.value.unclassified);
});

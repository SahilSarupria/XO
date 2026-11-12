import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodesOfKind } from '@xo/xoir';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { interpretPrompt } from '../../src/prompt/interpret.js';

// A domain profile extends the grammar's state vocabulary for ONE compilation. The neutral core must not know these words.
const TEXT =
  '# Rules\n1.1 If the sample is quarantined, the operator must log the event.\n1.2 If the sample is quarantined, the request must be rejected unless the batch is flagged.\n';
const LEX = { categoricalStates: ['quarantined', 'flagged'] };

const structured = (graph: Parameters<typeof nodesOfKind>[0]) =>
  [...nodesOfKind(graph, 'heuristic'), ...nodesOfKind(graph, 'decision_node')]
    .map((n) => n.properties as Record<string, unknown>)
    .filter((p) => p['structuredCondition'] !== undefined);

test('without a profile the domain word is not structured (neutral core), with one it is — same input, same pipeline', async () => {
  const plain = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'r.md' }], {});
  const profiled = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'r.md' }], { lexicon: LEX });
  assert.equal(plain.ok && profiled.ok, true);
  if (!plain.ok || !profiled.ok) return;
  assert.equal(structured(plain.value.graph).length, 0);
  assert.ok(structured(profiled.value.graph).length >= 1);
});

test('the profile also reaches structured exceptions (merge step), not only conditions', async () => {
  const r = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'r.md' }], { lexicon: LEX });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const withExc = [...nodesOfKind(r.value.graph, 'heuristic')]
    .map((n) => n.properties as Record<string, unknown>)
    .find((p) => String(p['action']).includes('must be rejected'))!;
  const se = withExc['structuredExceptions'] as { raw: string; condition?: unknown }[] | undefined;
  assert.ok(se && se.length === 1 && se[0]!.condition !== undefined, JSON.stringify(se));
});

test('a profile on one compilation never leaks into a later one without it', async () => {
  await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'r.md' }], { lexicon: LEX });
  const after = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'r.md' }], {});
  assert.equal(after.ok && structured(after.value.graph).length, 0);
});

test('prompt interpretation honours the same profile when judging whether a condition can be formalized', () => {
  const text = 'If the sample is quarantined, the request must be rejected.';
  assert.ok(interpretPrompt(text).questions.some((q) => q.reason === 'unformalized-condition'));
  assert.equal(
    interpretPrompt(text, LEX).questions.some((q) => q.reason === 'unformalized-condition'),
    false,
  );
});

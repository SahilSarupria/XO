import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncoveredNormativeSentences } from '../../src/reasoning/coverage.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

// Domain-neutral wording.
test('a normative sentence with no matching extracted node is reported; a covered one is not', () => {
  const units = ['Approve every request. If the widget count exceeds 5, approve the request.'];
  const nodes = [{ texts: ['the widget count exceeds 5', 'approve the request'] }];
  const out = uncoveredNormativeSentences(units, nodes);
  assert.deepEqual(
    out.map((s) => s.sentence),
    ['Approve every request.'],
  );
});

test('non-normative sentences (reference, definition, heading) are never reported as uncovered', () => {
  const out = uncoveredNormativeSentences(['## 1. Overview\nThe study enrolled 240 participants. A widget means a unit of work.'], []);
  assert.deepEqual(out, []);
});

test('a node whose text is a fragment of the sentence still counts as covering it', () => {
  const out = uncoveredNormativeSentences(
    ['The operator must log each event within one hour.'],
    [{ texts: ['the operator must log each event'] }],
  );
  assert.deepEqual(out, []);
});

test('compile surfaces uncovered normative sentences as an info diagnostic that names the sentence', async () => {
  const r = await compileSources(
    [
      {
        kind: 'document',
        text: '# Rules\nThe party responsible for reviewing the annual compliance summary may sign off.\nIf the widget count exceeds 5, approve the request.\n',
        sourcePath: 'r.md',
      },
    ],
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.value.diagnostics.filter((x) => x.code === 'coverage/normative-sentence-not-extracted');
  assert.equal(d.length, 1);
  assert.match(d[0]!.message, /party responsible for reviewing/);
  assert.match(d[0]!.message, /^An? (?:rule|obligation|permission|prohibition|procedure) sentence/);
});

test('a fully covered document produces no coverage diagnostics', async () => {
  const r = await compileSources(
    [{ kind: 'document', text: '# Rules\nIf the widget count exceeds 5, approve the request.\n', sourcePath: 'r.md' }],
    {},
  );
  assert.equal(r.ok, true);
  if (r.ok)
    assert.equal(
      r.value.diagnostics.some((x) => x.code === 'coverage/normative-sentence-not-extracted'),
      false,
    );
});

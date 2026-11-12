import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodesOfKind } from '@xo/xoir';
import { compileSources } from '../../src/pipeline/compile-sources.js';

// Domain-neutral wording. A prompt is a `user_instruction` source: it may be previewed, and it only compiles once an
// accountable identity has confirmed it.
const RULE = 'If the widget count exceeds 5, approve the request.';
const DOC = {
  kind: 'document' as const,
  text: '# Notes\nThe study enrolled 240 participants across three sites.\n',
  sourcePath: 'notes.md',
};

const ruleProps = (graph: Parameters<typeof nodesOfKind>[0]) =>
  [...nodesOfKind(graph, 'heuristic'), ...nodesOfKind(graph, 'decision_node')].map((n) => n.properties as Record<string, unknown>);

test('an unconfirmed prompt contributes nothing to the graph but is reported, with its interpretation and a warning', async () => {
  const r = await compileSources([DOC, { kind: 'prompt', text: RULE, sourcePath: 'p1' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(ruleProps(r.value.graph).length, 0);
  const report = r.value.sources.find((s) => s.sourceType === 'prompt')!;
  assert.equal(report.sourceClass, 'user_instruction');
  assert.equal(report.unitCount, 0);
  assert.ok(r.value.diagnostics.some((d) => d.code === 'prompt/awaiting-confirmation'));
  assert.equal(r.value.promptInterpretations?.length, 1);
  assert.equal(r.value.promptInterpretations?.[0]?.confirmed, false);
  assert.equal(r.value.promptInterpretations?.[0]?.interpretation.statements.length, 1);
});

test('a prompt-only compile that is unconfirmed fails clearly instead of producing an empty "success"', async () => {
  const r = await compileSources([{ kind: 'prompt', text: RULE, sourcePath: 'p1' }], {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error.message, /confirm/i);
});

test('a blank or whitespace-only confirmation is not a confirmation', async () => {
  const r = await compileSources([DOC, { kind: 'prompt', text: RULE, sourcePath: 'p1', confirmedBy: '   ' }], {});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(ruleProps(r.value.graph).length, 0);
});

test('a confirmed prompt compiles through the same typed pipeline and records who confirmed it', async () => {
  const r = await compileSources([{ kind: 'prompt', text: RULE, sourcePath: 'p1', confirmedBy: 'owner@example.test' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(ruleProps(r.value.graph).length >= 1);
  assert.ok(r.value.diagnostics.some((d) => d.code === 'prompt/confirmed' && d.message.includes('owner@example.test')));
  assert.equal(
    r.value.diagnostics.some((d) => d.code === 'prompt/awaiting-confirmation'),
    false,
  );
  assert.equal(r.value.sources[0]!.sourceClass, 'user_instruction');
});

test('prompt-authored and document-authored rules converge on the SAME canonical node representation', async () => {
  const fromPrompt = await compileSources([{ kind: 'prompt', text: RULE, sourcePath: 'p', confirmedBy: 'owner@example.test' }], {});
  const fromDoc = await compileSources([{ kind: 'document', text: RULE, sourcePath: 'd.md' }], {});
  assert.equal(fromPrompt.ok && fromDoc.ok, true);
  if (!fromPrompt.ok || !fromDoc.ok) return;
  const pick = (graph: Parameters<typeof nodesOfKind>[0]) =>
    ruleProps(graph).map((p) => ({
      q: p['condition'] ?? p['question'],
      o: p['outcome'] ?? p['action'],
      m: p['modality'],
      t: p['outcomeType'],
      sc: p['structuredCondition'] ?? null,
    }));
  assert.deepEqual(pick(fromPrompt.value.graph), pick(fromDoc.value.graph));
  assert.ok(pick(fromPrompt.value.graph).length >= 1);
});

test('intents are never compiled into executable capabilities, even when confirmed, and are reported as unformalized', async () => {
  const r = await compileSources(
    [
      {
        kind: 'prompt',
        text: 'Build a system that emails the owner.\nIf the widget count exceeds 5, approve the request.',
        sourcePath: 'p',
        confirmedBy: 'owner@example.test',
      },
    ],
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const names = nodesOfKind(r.value.graph, 'capability').map((n) =>
    String((n.properties as Record<string, unknown>)['name']).toLowerCase(),
  );
  assert.equal(
    names.some((n) => n.includes('email')),
    false,
  );
  assert.ok(r.value.diagnostics.some((d) => d.code === 'prompt/unformalized-intent'));
  // questions survive as diagnostics so the author can see what was not understood
  assert.ok(r.value.diagnostics.some((d) => d.code === 'prompt/clarification-needed' && /recipient|receives/i.test(d.message)));
});

test('document sources are unaffected: no sourceClass, no prompt diagnostics, no promptInterpretations', async () => {
  const r = await compileSources([{ kind: 'document', text: RULE, sourcePath: 'd.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.sources[0]!.sourceClass, undefined);
  assert.equal(r.value.promptInterpretations, undefined);
  assert.equal(
    r.value.diagnostics.some((d) => d.code.startsWith('prompt/')),
    false,
  );
});

test('an empty prompt is rejected at ingestion', async () => {
  const r = await compileSources([{ kind: 'prompt', text: '   ', sourcePath: 'p' }], {});
  assert.equal(r.ok, false);
});

test('a confirmed prompt with only purpose statements compiles nothing and says so', async () => {
  const r = await compileSources(
    [DOC, { kind: 'prompt', text: 'Build a system that emails the owner.', sourcePath: 'p', confirmedBy: 'owner@example.test' }],
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.diagnostics.some((d) => d.code === 'prompt/no-formalizable-statements'));
  assert.equal(
    nodesOfKind(r.value.graph, 'capability').some((n) => /email/i.test(String((n.properties as Record<string, unknown>)['name']))),
    false,
  );
  const alone = await compileSources(
    [{ kind: 'prompt', text: 'Build a system that emails the owner.', sourcePath: 'p', confirmedBy: 'owner@example.test' }],
    {},
  );
  assert.equal(alone.ok, false);
  if (!alone.ok) assert.match(alone.error.message, /no rule-shaped statements/);
});

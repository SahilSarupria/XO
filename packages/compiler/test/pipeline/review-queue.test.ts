import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const DOC = [
  '# Rules',
  '1.1 If the widget count exceeds 5, the operator must log the event.',
  '1.2 If the gadget behaves oddly, the request must be rejected.',
  '1.3 If the widget count exceeds 9, the request must be rejected unless the gadget is approved.',
  '1.4 If the widget count exceeds 12, the supplier may suspend the line.',
  '1.5 If the widget count exceeds 20, manager approval is required.',
  'The party responsible for reviewing the annual compliance summary may sign off.',
].join('\n');

async function queue(text: string, opts = {}) {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'r.md' }], opts);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value.reviewQueue!;
}
const kinds = (q: Awaited<ReturnType<typeof queue>>) => q.items.map((i) => i.kind);

test('every category of "needs a person" appears with a reason, and clean deterministic rules do not', async () => {
  const q = await queue(DOC);
  const k = kinds(q);
  assert.ok(k.includes('unresolved-condition'), 'cannot structure the gadget condition');
  assert.ok(k.includes('preserved-exception'), 'exception kept as text');
  assert.ok(k.includes('non-mandatory-rule'), 'permission');
  assert.ok(k.includes('human-required'), 'approval needed');
  assert.ok(k.includes('uncovered-sentence'), 'long-subject modal sentence');
  const texts = JSON.stringify(q.items);
  assert.equal(texts.includes('operator must log the event') && q.items.some((i) => i.kind === 'unresolved-condition' && /log the event/.test(i.summary)), false);
});

test('items carry a stable id, a priority and a human summary; the queue is sorted blocking-first', async () => {
  const q = await queue(DOC);
  for (const i of q.items) {
    assert.match(i.id, /^rq_[0-9a-f]{12}$/);
    assert.ok([1, 2, 3].includes(i.priority));
    assert.ok(i.summary.length > 0);
  }
  const priorities = q.items.map((i) => i.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b));
  assert.deepEqual((await queue(DOC)).items.map((i) => i.id), q.items.map((i) => i.id)); // deterministic
});

test('a fully clean document has an empty queue', async () => {
  const q = await queue('# Rules\n1.1 If the widget count exceeds 5, the operator must log the event.\n');
  assert.deepEqual(q.items.filter((i) => i.priority < 3), []);
});

test('summary counts by kind add up', async () => {
  const q = await queue(DOC);
  const total = Object.values(q.summary.byKind).reduce((a, b) => a + b, 0);
  assert.equal(total, q.items.length);
});

test('prompt clarification questions and an unknown domain enter the queue', async () => {
  const r = await compileSources([{ kind: 'prompt', text: 'Build a system that emails the owner.\nIf the widget count exceeds 5, approve the request.', sourcePath: 'p', confirmedBy: 'o@x.test' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const k = r.value.reviewQueue!.items.map((i) => i.kind);
  assert.ok(k.includes('clarification-question'));
  assert.ok(k.includes('unformalized-intent'));
  assert.ok(k.includes('unknown-domain'));
});

test('an OCR-required PDF page is a blocking review item', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/scanned-image-only.pdf', import.meta.url))));
  const r = await compileSources([{ kind: 'pdf', bytes, sourcePath: 's.pdf' }, { kind: 'document', text: DOC, sourcePath: 'r.md' }], {});
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.value.reviewQueue!.items.some((i) => i.kind === 'ocr-required' && i.priority === 1));
});

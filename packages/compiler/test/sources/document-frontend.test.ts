import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSourceFrontend } from '../../src/sources/document-frontend.js';

const frontend = new DocumentSourceFrontend();

test('canHandle accepts tagged document input, rejects everything else', () => {
  assert.equal(frontend.canHandle({ kind: 'document', text: 'hello', sourcePath: 'a.txt' }), true);
  assert.equal(frontend.canHandle({ kind: 'html', html: '<p>x</p>', sourcePath: 'a.html' }), false);
  assert.equal(frontend.canHandle(null), false);
});

test('classifies markdown-style headings, paragraphs, and list items into a nested ParsedDocument', () => {
  const text = ['# Title', '', 'Intro paragraph one.', 'Intro paragraph one continues.', '', '## Section A', '', '- first item', '- second item', '', 'Closing paragraph.'].join('\n');

  const result = frontend.ingest({ kind: 'document', text, sourcePath: 'doc.md' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sourceType, 'document');
  assert.equal(result.value.semanticExtractionAvailable, true);
  assert.equal(result.value.content.kind, 'document');
  if (result.value.content.kind !== 'document') return;

  const root = result.value.content.parsed.root;
  assert.equal(root.subsections.length, 1);
  const titleSection = root.subsections[0]!;
  assert.equal(titleSection.heading?.text, 'Title');
  assert.equal(titleSection.heading?.level, 1);
  assert.equal(titleSection.blocks.length, 1);
  assert.equal(titleSection.blocks[0]!.kind, 'paragraph');
  if (titleSection.blocks[0]!.kind === 'paragraph') {
    assert.match(titleSection.blocks[0].text, /Intro paragraph one\. Intro paragraph one continues\./);
  }

  assert.equal(titleSection.subsections.length, 1);
  const sectionA = titleSection.subsections[0]!;
  assert.equal(sectionA.heading?.text, 'Section A');
  assert.equal(sectionA.heading?.level, 2);
  const kinds = sectionA.blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ['list_item', 'list_item', 'paragraph']);
});

test('empty document content is rejected as SOURCE_CONTENT_UNAVAILABLE', () => {
  const result = frontend.ingest({ kind: 'document', text: '   \n  \n', sourcePath: 'empty.txt' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PRECONDITION_FAILED');
});

test('block provenance is synthetic but ordered: earlier blocks have a higher yRange top than later ones', () => {
  const text = '# H\n\nfirst paragraph\n\nsecond paragraph';
  const result = frontend.ingest({ kind: 'document', text, sourcePath: 'ordered.txt' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  const section = result.value.content.parsed.root.subsections[0]!;
  const [first, second] = section.blocks;
  assert.ok(first!.provenance.yRange[0] > second!.provenance.yRange[0]);
});

test('ingest is deterministic for identical text and path', () => {
  const input = { kind: 'document' as const, text: 'Stable content.', sourcePath: 'stable.txt' };
  const a = frontend.ingest(input);
  const b = frontend.ingest(input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) {
    assert.equal(a.value.sourceId, b.value.sourceId);
    assert.deepEqual(a.value.content, b.value.content);
  }
});

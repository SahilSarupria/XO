import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections } from '../../src/document/section-builder.js';
import type { DocumentBlock } from '../../src/document/types.js';

function heading(text: string, level: number): DocumentBlock {
  return { kind: 'heading', level, text, provenance: { page: 1, yRange: [700, 700] } };
}
function paragraph(text: string): DocumentBlock {
  return { kind: 'paragraph', text, provenance: { page: 1, yRange: [600, 600] } };
}

test('a document with no headings puts every block in the root section', () => {
  const root = buildSections([paragraph('A'), paragraph('B')]);
  assert.equal(root.heading, undefined);
  assert.equal(root.blocks.length, 2);
  assert.equal(root.subsections.length, 0);
});

test('a single heading opens one subsection containing what follows', () => {
  const root = buildSections([heading('Section 1', 1), paragraph('Body of section 1')]);
  assert.equal(root.subsections.length, 1);
  assert.equal(root.subsections[0]!.heading?.text, 'Section 1');
  assert.equal(root.subsections[0]!.blocks.length, 1);
});

test('a level-2 heading nests inside the preceding level-1 section', () => {
  const root = buildSections([heading('Chapter 1', 1), paragraph('Intro'), heading('1.1 Subsection', 2), paragraph('Subsection body')]);
  const chapter = root.subsections[0]!;
  assert.equal(chapter.heading?.text, 'Chapter 1');
  assert.equal(chapter.blocks.length, 1); // "Intro"
  assert.equal(chapter.subsections.length, 1);
  assert.equal(chapter.subsections[0]!.heading?.text, '1.1 Subsection');
});

test('a second level-1 heading closes the first level-1 section (siblings, not nested)', () => {
  const root = buildSections([heading('Chapter 1', 1), paragraph('A'), heading('Chapter 2', 1), paragraph('B')]);
  assert.equal(root.subsections.length, 2);
  assert.equal(root.subsections[0]!.heading?.text, 'Chapter 1');
  assert.equal(root.subsections[1]!.heading?.text, 'Chapter 2');
});

test('a level-1 heading after a level-2 subsection closes both and starts a new top-level section', () => {
  const root = buildSections([heading('Chapter 1', 1), heading('1.1', 2), paragraph('deep'), heading('Chapter 2', 1)]);
  assert.equal(root.subsections.length, 2);
  assert.equal(root.subsections[0]!.subsections.length, 1);
  assert.equal(root.subsections[1]!.subsections.length, 0);
});

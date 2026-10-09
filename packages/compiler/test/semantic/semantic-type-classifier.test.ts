import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlock } from '../../src/semantic/semantic-type-classifier.js';
import type { DocumentBlock } from '../../src/document/types.js';

const prov = { page: 1, yRange: [700, 700] as const };

function paragraph(text: string): DocumentBlock {
  return { kind: 'paragraph', text, provenance: prov };
}
function listItem(text: string, marker = '1.'): DocumentBlock {
  return { kind: 'list_item', marker, listKind: 'ordered', text, provenance: prov };
}
function footnote(text: string): DocumentBlock {
  return { kind: 'footnote', text, provenance: prov };
}

test('a footnote block is always explanatory_note with full confidence', () => {
  const result = classifyBlock(footnote('See appendix A for details.'));
  assert.equal(result.semanticType, 'explanatory_note');
  assert.equal(result.confidence, 1);
});

test('a defined-term pattern classifies as definition and captures the term', () => {
  const result = classifyBlock(paragraph('"Confidential Information" means any data disclosed under this Agreement.'));
  assert.equal(result.semanticType, 'definition');
  assert.equal(result.definedTerm, 'Confidential Information');
});

test('an exception cue classifies as exception', () => {
  const result = classifyBlock(paragraph('Unless otherwise agreed in writing, this clause applies.'));
  assert.equal(result.semanticType, 'exception');
});

test('an example cue classifies as example', () => {
  const result = classifyBlock(paragraph('For example, trade secrets and customer lists are covered.'));
  assert.equal(result.semanticType, 'example');
});

test('an obligation cue classifies as obligation', () => {
  const result = classifyBlock(paragraph('The Receiving Party shall maintain confidentiality at all times.'));
  assert.equal(result.semanticType, 'obligation');
});

test('a right cue classifies as right', () => {
  const result = classifyBlock(paragraph('The Disclosing Party may terminate this Agreement upon notice.'));
  assert.equal(result.semanticType, 'right');
});

test('a list item with no lexical cue defaults to clause', () => {
  const result = classifyBlock(listItem('Governing law is the State of Delaware.'));
  assert.equal(result.semanticType, 'clause');
});

test('a plain paragraph with no lexical cue defaults to general', () => {
  const result = classifyBlock(paragraph('This is a plain introductory sentence.'));
  assert.equal(result.semanticType, 'general');
});

test('exception is checked before obligation when both cues are present', () => {
  const result = classifyBlock(paragraph('The Receiving Party shall comply unless prohibited by law.'));
  assert.equal(result.semanticType, 'exception');
});

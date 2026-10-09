import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeTitle } from '../../src/semantic/title.js';

test('uses the whole content when it is short', () => {
  assert.equal(synthesizeTitle('A short clause.'), 'A short clause.');
});

test('truncates long content to the first 8 words with an ellipsis', () => {
  const title = synthesizeTitle('one two three four five six seven eight nine ten');
  assert.equal(title, 'one two three four five six seven eight…');
});

test('returns a placeholder for empty content', () => {
  assert.equal(synthesizeTitle(''), '(untitled)');
  assert.equal(synthesizeTitle('   '), '(untitled)');
});

test('collapses multiple whitespace characters between words', () => {
  assert.equal(synthesizeTitle('word1   word2\nword3'), 'word1 word2 word3');
});

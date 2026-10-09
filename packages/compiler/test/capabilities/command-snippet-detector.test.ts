import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCommandSnippets } from '../../src/capabilities/command-snippet-detector.js';

test('detects a simple function-call-like snippet', () => {
  const snippets = detectCommandSnippets('Call sendEmail(to, subject, body) to notify the client.');
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0]!.text, 'sendEmail(to, subject, body)');
});

test('detects a dotted identifier snippet', () => {
  const snippets = detectCommandSnippets('Use xo.compile(path) to run the compiler.');
  assert.equal(snippets[0]!.text, 'xo.compile(path)');
});

test('handles nested parentheses correctly', () => {
  const snippets = detectCommandSnippets('Run wrap(inner(a, b), c) as shown.');
  assert.equal(snippets[0]!.text, 'wrap(inner(a, b), c)');
});

test('does not report an unterminated open paren', () => {
  const snippets = detectCommandSnippets('This has an unmatched call(a, b without a close.');
  assert.deepEqual(snippets, []);
});

test('reports correct offsets', () => {
  const text = 'Please invoke doThing(x) now.';
  const snippets = detectCommandSnippets(text);
  assert.equal(text.slice(snippets[0]!.startOffset, snippets[0]!.endOffset), 'doThing(x)');
});

test('ignores a single-character identifier immediately followed by a paren (too short to be a real call)', () => {
  const snippets = detectCommandSnippets('The formula x(a) is shown here.');
  assert.deepEqual(snippets, []);
});

test('detects multiple snippets in the same text', () => {
  const snippets = detectCommandSnippets('First run stepOne(a) then call stepTwo(b).');
  assert.equal(snippets.length, 2);
});

test('returns no snippets for plain prose', () => {
  const snippets = detectCommandSnippets('This is an ordinary sentence with no code.');
  assert.deepEqual(snippets, []);
});

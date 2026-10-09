import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from '../../src/pdf/lexer.js';

function tokenize(text: string): ReturnType<Lexer['next']>[] {
  const lexer = new Lexer(new Uint8Array(Buffer.from(text, 'latin1')));
  const tokens = [];
  for (;;) {
    const t = lexer.next();
    if (t.kind === 'eof') break;
    tokens.push(t);
  }
  return tokens;
}

test('tokenizes numbers, names, and keywords', () => {
  const tokens = tokenize('42 -3.14 /Name true false null R obj');
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text]),
    [
      ['number', '42'],
      ['number', '-3.14'],
      ['name', 'Name'],
      ['keyword', 'true'],
      ['keyword', 'false'],
      ['keyword', 'null'],
      ['keyword', 'R'],
      ['keyword', 'obj'],
    ],
  );
});

test('decodes a literal string with escape sequences', () => {
  const tokens = tokenize('(Hello\\nWorld \\(nested\\) \\061)');
  assert.equal(tokens.length, 1);
  assert.equal(Buffer.from(tokens[0]!.bytes!).toString('latin1'), 'Hello\nWorld (nested) 1');
});

test('decodes a literal string with balanced nested parens without escaping', () => {
  const tokens = tokenize('(outer (inner) outer)');
  assert.equal(Buffer.from(tokens[0]!.bytes!).toString('latin1'), 'outer (inner) outer');
});

test('decodes a hex string, padding an odd trailing digit with 0', () => {
  const tokens = tokenize('<48656C6C6F>');
  assert.equal(Buffer.from(tokens[0]!.bytes!).toString('latin1'), 'Hello');
  const odd = tokenize('<48656C6C6F0>'); // trailing odd nibble
  assert.equal(odd[0]!.kind, 'hexstring');
});

test('handles /Name with #xx hex-escaped characters', () => {
  const tokens = tokenize('/A#20Name');
  assert.equal(tokens[0]!.text, 'A Name');
});

test('distinguishes dict_start/dict_end from array/other delimiters', () => {
  const tokens = tokenize('<< /A [1 2 3] >>');
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ['dict_start', 'name', 'array_start', 'number', 'number', 'number', 'array_end', 'dict_end'],
  );
});

test('skips comments', () => {
  const tokens = tokenize('1 % this is a comment\n2');
  assert.deepEqual(
    tokens.map((t) => t.text),
    ['1', '2'],
  );
});

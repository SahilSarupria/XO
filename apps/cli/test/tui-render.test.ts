import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPainter, detectColorLevel, gradientColor, stripAnsi, truncate, visibleLength, wrapAnsi, charWidth } from '../src/tui/ansi.js';
import { renderBox } from '../src/tui/box.js';
import { highlightLine, highlightOutput } from '../src/tui/highlight.js';
import { renderMarkdown } from '../src/tui/markdown.js';
import { renderBanner } from '../src/tui/banner.js';
import { DEFAULT_THEME, THEMES, createUi } from '../src/tui/theme.js';

const ui3 = createUi(DEFAULT_THEME, createPainter(3));
const ui0 = createUi(DEFAULT_THEME, createPainter(0));

test('detectColorLevel honors NO_COLOR, FORCE_COLOR, TERM=dumb, TTY-ness, and COLORTERM', () => {
  assert.equal(detectColorLevel({ isTTY: true }, { NO_COLOR: '1', COLORTERM: 'truecolor' }), 0);
  assert.equal(detectColorLevel({ isTTY: false }, {}), 0);
  assert.equal(detectColorLevel({ isTTY: false }, { FORCE_COLOR: '1' }), 1);
  assert.equal(detectColorLevel({ isTTY: true }, { FORCE_COLOR: '0', COLORTERM: 'truecolor' }), 0);
  assert.equal(detectColorLevel({ isTTY: true }, { TERM: 'dumb' }), 0);
  assert.equal(detectColorLevel({ isTTY: true }, { COLORTERM: 'truecolor' }), 3);
  assert.equal(detectColorLevel({ isTTY: true }, { TERM: 'xterm-256color' }), 2);
  assert.equal(detectColorLevel({ isTTY: true }, { TERM: 'xterm' }), 1);
  assert.equal(detectColorLevel({ isTTY: true, getColorDepth: () => 24 }, {}), 3);
});

test('a level-0 painter returns text unchanged; higher levels only add escape codes', () => {
  const p0 = createPainter(0);
  assert.equal(p0.fg('#ff0000', 'x'), 'x');
  assert.equal(p0.bold('x'), 'x');
  for (const level of [1, 2, 3] as const) {
    const p = createPainter(level);
    assert.equal(stripAnsi(p.fg('#7aa2f7', p.bold('hello'))), 'hello');
    assert.notEqual(p.fg('#7aa2f7', 'hello'), 'hello');
  }
  assert.match(createPainter(3).fg('#102030', 'x'), /38;2;16;32;48/);
  assert.match(createPainter(2).fg('#102030', 'x'), /38;5;\d+/);
});

test('gradientColor interpolates between stops and clamps', () => {
  assert.equal(gradientColor(['#000000', '#ffffff'], 0), '#000000');
  assert.equal(gradientColor(['#000000', '#ffffff'], 1), '#ffffff');
  assert.equal(gradientColor(['#000000', '#ffffff'], 0.5), '#808080');
  assert.equal(gradientColor(['#000000', '#ffffff'], 9), '#ffffff');
});

test('visibleLength ignores escapes and counts wide characters as two columns', () => {
  assert.equal(visibleLength(createPainter(3).fg('red', 'abc')), 3);
  assert.equal(visibleLength('漢字'), 4);
  assert.equal(charWidth('e'.codePointAt(0)!), 1);
  assert.equal(charWidth(0x301), 0);
});

test('truncate keeps styling intact and never exceeds the width', () => {
  const styled = createPainter(3).fg('#ff0000', 'abcdefghij');
  const cut = truncate(styled, 5);
  assert.equal(visibleLength(cut), 5);
  assert.equal(stripAnsi(cut), 'abcd…');
  assert.equal(truncate('short', 10), 'short');
});

test('wrapAnsi wraps at word boundaries, hard-breaks long words, and re-opens styles on continuation lines', () => {
  const plain = wrapAnsi('the quick brown fox jumps over the lazy dog', 15);
  assert.ok(plain.every((l) => visibleLength(l) <= 15));
  assert.equal(plain.join(' '), 'the quick brown fox jumps over the lazy dog');

  assert.deepEqual(wrapAnsi('abcdefghij', 4).map(stripAnsi), ['abcd', 'efgh', 'ij']);

  const red = createPainter(3).fg('#ff0000', 'aaaa bbbb cccc dddd');
  const lines = wrapAnsi(red, 9);
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.match(l, /\u001b\[38;2;255;0;0m/, 'each wrapped line re-opens the color');
  assert.equal(lines.map(stripAnsi).join(' '), 'aaaa bbbb cccc dddd');
});

test('wrapAnsi preserves leading indentation on continuation lines', () => {
  const lines = wrapAnsi('    indented text that needs to wrap around', 20).map(stripAnsi);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.match(l, /^ {4}\S/);
});

test('renderBox: every line is exactly `width` columns, with title and footer embedded', () => {
  for (const width of [30, 60, 100]) {
    const box = renderBox(['short', 'a much longer line that has to wrap because it exceeds the inner width of the box'], {
      width,
      title: 'title here',
      footer: '1.2s',
      borderColor: (t) => t,
    });
    for (const line of box) assert.equal(visibleLength(line), width, `width ${width}: ${line}`);
    assert.match(box[0]!, /╭─ title here ─+╮/);
    assert.match(box[box.length - 1]!, /╰─+ 1\.2s ─╯/);
  }
});

test('renderBox tolerates empty content and an over-long title', () => {
  const box = renderBox([], { width: 24, title: 'x'.repeat(200), borderColor: (t) => t });
  assert.ok(box.length >= 3);
  for (const l of box) assert.equal(visibleLength(l), 24);
});

test('highlightLine never changes the visible text of a line (all themes, several color levels)', () => {
  const samples = [
    'error: could not read "x.pdf": ENOENT',
    'warning: "pkg@1.0.0" failed to mount: [E] nope',
    'note: deterministic execution was not selected',
    '[PASS] schema',
    '[FAIL] hashes',
    '[WARN] signature',
    'VALID',
    'INVALID',
    'SAFE',
    'UNSAFE',
    'ok  node_version  Node 22.1.0 (need >= 20)',
    'FAIL  node_version  Node 18',
    'Sources:',
    'Compilation:',
    '  nodes:   311',
    '  - id: value with SHA sha256:9f3ab2c4d5e6f7089a1b2c3d4e5f6071',
    '      - claim_amount  type: number  derivedFrom: rule  -> MISSING',
    '      - x  type: string  -> injected (from a.b)',
    '--- receipt ---',
    '========================================================================',
    '  "matched": true,',
    '  escalation_required and waiting_for_human',
    'Workflow status:     waiting_for_human',
    '  plain text with no special shape at all',
    '',
    'UNRESOLVED — not executed  (no binding)',
  ];
  for (const theme of THEMES) {
    for (const level of [1, 2, 3] as const) {
      const ui = createUi(theme, createPainter(level));
      for (const s of samples) assert.equal(stripAnsi(highlightLine(s, ui)), s, `${theme.name}/${level}: ${JSON.stringify(s)}`);
    }
  }
  for (const s of samples) assert.equal(highlightLine(s, ui0), s);
});

test('highlightLine actually colors the shapes it claims to (level 3)', () => {
  assert.notEqual(highlightLine('error: boom', ui3), 'error: boom');
  assert.notEqual(highlightLine('[PASS] schema', ui3), '[PASS] schema');
  assert.notEqual(highlightLine('Sources:', ui3), 'Sources:');
  assert.equal(highlightLine('nothing special here', ui3), 'nothing special here');
});

test('highlightOutput pretty-prints one-line JSON and leaves other lines\' text alone', () => {
  const lines = highlightOutput('{"status":"completed","n":[1,2]}', ui0);
  assert.deepEqual(lines, ['{', '  "status": "completed",', '  "n": [', '    1,', '    2', '  ]', '}']);
  const mixed = highlightOutput('error: nope\nfoo: bar\n\n', ui3).map(stripAnsi);
  assert.deepEqual(mixed, ['error: nope', 'foo: bar']);
  // Not-quite-JSON stays untouched.
  assert.deepEqual(highlightOutput('{not json', ui0), ['{not json']);
});

test('renderMarkdown handles headings, bullets, fences, and inline styles without dropping text at level 0', () => {
  const src = '# Title\n- one\n- two\n1. first\n> quote\n```ts\nconst x = 1;\n```\nplain **bold** and `code`';
  const out = renderMarkdown(src, ui0);
  assert.equal(out[0], 'Title');
  assert.match(out[1]!, /^• one$/);
  assert.match(out[3]!, /^1\. first$/);
  assert.ok(out.some((l) => l.includes('const x = 1;')));
  assert.equal(out[out.length - 1], 'plain **bold** and `code`');
  const styled = renderMarkdown('plain **bold** and `code`', ui3)[0]!;
  assert.equal(stripAnsi(styled), 'plain bold and code');
});

test('renderBanner shows the logo on wide terminals and a compact header on narrow ones', () => {
  const wide = renderBanner(ui0, '1.2.3', 100).join('\n');
  assert.match(wide, /██╗/);
  assert.match(wide, /v1\.2\.3/);
  assert.match(wide, /Tips for getting started/);
  const narrow = renderBanner(ui0, '1.2.3', 20).join('\n');
  assert.doesNotMatch(narrow, /██╗/);
  assert.match(narrow, /v1\.2\.3/);
  for (const l of renderBanner(ui0, '1.2.3', 40)) assert.ok(visibleLength(l) <= 40, l);
});

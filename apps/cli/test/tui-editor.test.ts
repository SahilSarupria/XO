import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPainter, visibleLength } from '../src/tui/ansi.js';
import { computeSuggestions } from '../src/tui/completion.js';
import { History } from '../src/tui/history.js';
import { PromptEditor, type ReadResult } from '../src/tui/input.js';
import { sessionCatalog } from '../src/tui/slash-commands.js';
import { DEFAULT_THEME, createUi } from '../src/tui/theme.js';
import { KEY, fakeTerminal, settle, type FakeTerminal } from './tui-helpers.js';

function makeEditor(term: FakeTerminal, now: () => number = Date.now): { editor: PromptEditor; history: History } {
  const history = new History(undefined);
  const catalog = sessionCatalog();
  const editor = new PromptEditor({
    input: term.stdin,
    output: term.stdout,
    ui: () => createUi(DEFAULT_THEME, createPainter(0)),
    history,
    suggest: (buffer, cursor) => computeSuggestions(buffer, cursor, { catalog, cwd: process.cwd(), themes: ['xo-dark'], providers: ['anthropic'] }),
    footer: () => ({ left: 'left', center: 'center', right: 'right' }),
    now,
  });
  return { editor, history };
}

async function typeAndRead(keys: readonly string[], setup?: (t: FakeTerminal, e: PromptEditor, h: History) => Promise<void>): Promise<{ result: ReadResult; term: FakeTerminal; editor: PromptEditor }> {
  const term = fakeTerminal(80);
  const { editor, history } = makeEditor(term);
  if (setup) await setup(term, editor, history);
  const pending = editor.read();
  for (const k of keys) await term.send(k);
  const result = await pending;
  return { result, term, editor };
}

test('typing text and pressing Enter submits it; raw mode is enabled and bracketed paste turned on', async () => {
  const { result, term, editor } = await typeAndRead(['hello', KEY.enter]);
  assert.deepEqual(result, { kind: 'submit', text: 'hello', shell: false });
  assert.equal(term.stdin.rawMode, true);
  assert.match(term.raw(), /\u001b\[\?2004h/);
  editor.close();
  assert.equal(term.stdin.rawMode, false);
  assert.match(term.raw(), /\u001b\[\?2004l/);
});

test('the box is drawn, and the submitted line is left behind as an echo', async () => {
  const { term } = await typeAndRead(['hi there', KEY.enter]);
  const plain = term.plain();
  assert.match(plain, /╭─+╮/);
  assert.match(plain, /│ > hi there\s+│/);
  assert.match(plain, /Type \/ for commands/); // placeholder shown before typing
  assert.match(plain, /left\s+center\s+right/); // footer
});

test('editing: backspace, delete, cursor movement, insertion mid-line', async () => {
  const { result } = await typeAndRead(['abcd', KEY.backspace, KEY.left, KEY.left, 'X', KEY.right, KEY.right, 'Y', KEY.enter]);
  assert.equal((result as { text: string }).text, 'aXbcY');
});

test('readline-style shortcuts: Ctrl+A/E/U/K/W', async () => {
  const cases: [string[], string][] = [
    [['hello world', KEY.ctrlA, 'X', KEY.enter], 'Xhello world'],
    [['hello', KEY.ctrlA, KEY.ctrlE, '!!', KEY.enter], 'hello!!'],
    [['hello world', KEY.ctrlW, KEY.enter], 'hello '],
    [['hello world', KEY.left, KEY.left, KEY.left, KEY.left, KEY.left, KEY.ctrlK, KEY.enter], 'hello '],
    [['hello world', KEY.left, KEY.left, KEY.left, KEY.left, KEY.left, KEY.ctrlU, KEY.enter], 'world'],
  ];
  for (const [keys, expected] of cases) {
    const { result } = await typeAndRead(keys);
    assert.equal((result as { text: string }).text, expected, JSON.stringify(keys));
  }
});

test('Ctrl+J and a trailing backslash both insert a newline instead of submitting', async () => {
  const a = await typeAndRead(['one', KEY.ctrlJ, 'two', KEY.enter]);
  assert.equal((a.result as { text: string }).text, 'one\ntwo');
  const b = await typeAndRead(['one\\', KEY.enter, 'two', KEY.enter]);
  assert.equal((b.result as { text: string }).text, 'one\ntwo');
});

test('bracketed paste inserts multi-line text without submitting', async () => {
  const { result } = await typeAndRead([`${KEY.pasteStart}line a\nline b\r\nline c${KEY.pasteEnd}`, KEY.enter]);
  assert.equal((result as { text: string }).text, 'line a\nline b\nline c');
});

test('history: Up/Down walk previous submissions and restore the draft', async () => {
  const { result } = await typeAndRead([KEY.up, KEY.up, KEY.down, KEY.enter], async (_t, _e, h) => {
    h.add('first');
    h.add('second');
  });
  assert.equal((result as { text: string }).text, 'second');

  const draft = await typeAndRead(['draft', KEY.up, KEY.down, KEY.enter], async (_t, _e, h) => h.add('old'));
  assert.equal((draft.result as { text: string }).text, 'draft');
});

test('each submission is added to history for the next prompt', async () => {
  const term = fakeTerminal();
  const { editor } = makeEditor(term);
  let p = editor.read();
  await term.send('alpha');
  await term.send(KEY.enter);
  await p;
  p = editor.read();
  await term.send(KEY.up);
  await term.send(KEY.enter);
  assert.equal(((await p) as { text: string }).text, 'alpha');
});

test('Tab completes the highlighted slash command (and adds a space when it takes arguments)', async () => {
  const noArgs = await typeAndRead(['/cle', KEY.tab, KEY.enter]);
  assert.equal((noArgs.result as { text: string }).text, '/clear');
  const withArgs = await typeAndRead(['/theme', KEY.tab, 'dracula', KEY.enter]);
  assert.equal((withArgs.result as { text: string }).text, '/theme dracula');
});

test('Enter on a partial no-argument command accepts it and runs it; with arguments it only completes', async () => {
  const runs = await typeAndRead(['/cle', KEY.enter]);
  assert.deepEqual(runs.result, { kind: 'submit', text: '/clear', shell: false });

  const term = fakeTerminal();
  const { editor } = makeEditor(term);
  const pending = editor.read();
  await term.send('/the');
  await term.send(KEY.enter); // completes to "/theme " but does not submit
  await term.send('xo-dark');
  await term.send(KEY.enter);
  assert.equal(((await pending) as { text: string }).text, '/theme xo-dark');
});

test('Up/Down move through the suggestion menu instead of history while it is open', async () => {
  const { result } = await typeAndRead(['/s', KEY.down, KEY.tab, KEY.enter]);
  const text = (result as { text: string }).text.trim();
  assert.match(text, /^\/(stats|store|settings)$/);
});

test('Escape dismisses the menu so Enter submits exactly what was typed', async () => {
  const term = fakeTerminal();
  const { editor } = makeEditor(term);
  const pending = editor.read();
  await term.send('/cle');
  await term.send('\x1b');
  await new Promise((r) => setTimeout(r, 600)); // let readline resolve the lone ESC
  await term.send(KEY.enter);
  assert.equal(((await pending) as { text: string }).text, '/cle');
});

test('"!" at the start of an empty prompt enters shell mode; Backspace on empty leaves it', async () => {
  const shell = await typeAndRead(['!', 'ls -la', KEY.enter]);
  assert.deepEqual(shell.result, { kind: 'submit', text: 'ls -la', shell: true });

  const left = await typeAndRead(['!', KEY.backspace, 'x', KEY.enter]);
  assert.deepEqual(left.result, { kind: 'submit', text: 'x', shell: false });

  const bang = await typeAndRead(['hi!', KEY.enter]); // a "!" mid-text is just text
  assert.equal((bang.result as { text: string }).text, 'hi!');
});

test('Ctrl+C clears a non-empty line; on an empty line it needs a second press to exit', async () => {
  let clock = 1000;
  const term = fakeTerminal();
  const { editor } = makeEditor(term, () => clock);
  const pending = editor.read();
  await term.send('some text');
  await term.send(KEY.ctrlC); // clears
  await term.send(KEY.ctrlC); // arms
  assert.match(term.plain(), /Press Ctrl\+C again to exit\./);
  clock += 500;
  await term.send(KEY.ctrlC); // within the window: exits
  assert.deepEqual(await pending, { kind: 'exit' });
});

test('the exit window expires: two Ctrl+C presses far apart do not exit', async () => {
  let clock = 1000;
  const term = fakeTerminal();
  const { editor } = makeEditor(term, () => clock);
  let done = false;
  const pending = editor.read().then((r) => {
    done = true;
    return r;
  });
  await term.send(KEY.ctrlC);
  clock += 5000;
  await term.send(KEY.ctrlC);
  await settle();
  assert.equal(done, false);
  await term.send(KEY.ctrlC);
  assert.deepEqual(await pending, { kind: 'exit' });
});

test('Ctrl+D exits only from an empty line (twice); otherwise it deletes forward', async () => {
  const del = await typeAndRead(['abc', KEY.ctrlA, KEY.ctrlD, KEY.enter]);
  assert.equal((del.result as { text: string }).text, 'bc');

  const term = fakeTerminal();
  const { editor } = makeEditor(term);
  const pending = editor.read();
  await term.send(KEY.ctrlD);
  await term.send(KEY.ctrlD);
  assert.deepEqual(await pending, { kind: 'exit' });
});

test('busy mode swallows typing and reports Ctrl+C presses', async () => {
  let clock = 0;
  const term = fakeTerminal();
  const { editor } = makeEditor(term, () => clock);
  editor.open();
  const presses: number[] = [];
  editor.beginBusy((n) => presses.push(n));
  await term.send('typed while busy');
  await term.send(KEY.ctrlC);
  clock += 1000;
  await term.send(KEY.ctrlC);
  clock += 10_000;
  await term.send(KEY.ctrlC); // window elapsed: counts from 1 again
  assert.deepEqual(presses, [1, 2, 1]);
  editor.endBusy();
  const pending = editor.read();
  await term.send(KEY.enter);
  assert.deepEqual(await pending, { kind: 'submit', text: '', shell: false }); // nothing typed during busy leaked in
});

test('read() twice concurrently is rejected rather than corrupting state', async () => {
  const term = fakeTerminal();
  const { editor } = makeEditor(term);
  void editor.read();
  await assert.rejects(editor.read(), /already reading/);
});

test('the block never draws a line wider than the terminal (narrow widths)', async () => {
  for (const cols of [24, 40, 80]) {
    const term = fakeTerminal(cols);
    const { editor } = makeEditor(term);
    const pending = editor.read();
    await term.send('/co');
    await term.send('x'.repeat(100));
    await term.send(KEY.enter);
    await pending;
    for (const line of term.plain().split(/[\r\n]+/)) assert.ok(visibleLength(line) <= cols, `cols=${cols}: ${line}`);
  }
});

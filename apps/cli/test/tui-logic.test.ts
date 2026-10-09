import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize, stripAtPrefix } from '../src/tui/tokenize.js';
import { argHintFromUsage, buildCatalog, closestMatch, describeUsage, flagsFromUsage, type CatalogEntry } from '../src/tui/catalog.js';
import { CommandRegistry } from '../src/command-registry.js';
import { computeSuggestions, type CompletionContext } from '../src/tui/completion.js';
import { History, redactForHistory } from '../src/tui/history.js';
import { SettingsStore, xoHome } from '../src/tui/settings.js';
import { shortenPath, readGitBranch, clipboardCommands } from '../src/tui/env-info.js';
import { captureOutput } from '../src/tui/capture.js';
import { layoutBuffer } from '../src/tui/input.js';
import { SessionState, formatDuration } from '../src/tui/session.js';
import { sessionCatalog } from '../src/tui/slash-commands.js';
import { withTmp } from './tui-helpers.js';

// ------------------------------------------------------------- tokenizer

test('tokenize: whitespace, quotes, escapes', () => {
  assert.deepEqual(tokenize('compile a.pdf b.pdf').tokens, ['compile', 'a.pdf', 'b.pdf']);
  assert.deepEqual(tokenize('run cap --input "hello  world" --json').tokens, ['run', 'cap', '--input', 'hello  world', '--json']);
  assert.deepEqual(tokenize("x 'it''s' y").tokens, ['x', 'its', 'y']);
  assert.deepEqual(tokenize('my\\ file.pdf').tokens, ['my file.pdf']);
  assert.deepEqual(tokenize('say "a \\"quoted\\" word"').tokens, ['say', 'a "quoted" word']);
  assert.deepEqual(tokenize('""').tokens, ['']);
  assert.deepEqual(tokenize('   ').tokens, []);
});

test('tokenize keeps Windows-style backslashes and reports unterminated quotes', () => {
  assert.deepEqual(tokenize('compile C:\\Users\\me\\policy.pdf').tokens, ['compile', 'C:\\Users\\me\\policy.pdf']);
  assert.equal(tokenize('say "oops').unterminatedQuote, '"');
  assert.equal(tokenize("say 'oops").unterminatedQuote, "'");
  assert.equal(tokenize('fine').unterminatedQuote, undefined);
});

test('stripAtPrefix only strips a leading @ with something after it', () => {
  assert.equal(stripAtPrefix('@a.pdf'), 'a.pdf');
  assert.equal(stripAtPrefix('@'), '@');
  assert.equal(stripAtPrefix('a@b'), 'a@b');
});

// ------------------------------------------------------ usage -> catalog

// Verbatim shapes from the real registrars.
const USAGE_SINGLE = 'xo version                              Print the CLI version';
const USAGE_MULTI = 'xo init <dir> --name <n> --creator-did <did> [--version <v>] [--format-version <v>]\n                                         Scaffold a new package project';
const USAGE_RUN =
  'xo run <capabilityId> --input "<text>" --store <dir>\n' +
  '      [--provider anthropic|openai|azure-openai|gemini|ollama] [--model <id>]\n' +
  '      [--api-key <key>] [--json]\n' +
  '                                         Plan and execute a capability against an installed package';
const USAGE_COMPILE =
  'xo compile <source>... [--domain-hint <text>] [--focus-question <text>] [--json]\n' +
  '                                         Compile one or more sources into XOIR and print a summary';

test('describeUsage handles both usage shapes the registrars use', () => {
  assert.equal(describeUsage(USAGE_SINGLE), 'Print the CLI version');
  assert.equal(describeUsage(USAGE_MULTI), 'Scaffold a new package project');
  assert.equal(describeUsage(USAGE_RUN), 'Plan and execute a capability against an installed package');
  assert.equal(describeUsage('xo weird'), '');
});

test('argHintFromUsage returns positionals up to the first flag / optional group', () => {
  assert.equal(argHintFromUsage(USAGE_SINGLE, 'version'), undefined);
  assert.equal(argHintFromUsage(USAGE_MULTI, 'init'), '<dir>');
  assert.equal(argHintFromUsage(USAGE_RUN, 'run'), '<capabilityId>');
  assert.equal(argHintFromUsage(USAGE_COMPILE, 'compile'), '<source>...');
  assert.equal(argHintFromUsage('xo registry inspect <id> --registry <dir>', 'registry'), 'inspect <id>');
});

test('flagsFromUsage lists each --flag once, sorted', () => {
  assert.deepEqual(flagsFromUsage(USAGE_COMPILE), ['--domain-hint', '--focus-question', '--json']);
});

test('buildCatalog merges session commands with registry commands, sorted, without duplicates', () => {
  const registry = new CommandRegistry();
  registry.register({ name: 'compile', subsystem: 'compiler', usage: USAGE_COMPILE, run: () => 0 });
  registry.register({ name: 'version', subsystem: 'system', usage: USAGE_SINGLE, run: () => 0 });
  registry.register({ name: 'help', subsystem: 'system', usage: 'xo help  clash', run: () => 0 }); // clashes with a session command
  const catalog = buildCatalog(registry, sessionCatalog());
  const names = catalog.map((e) => e.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(names.filter((n) => n === 'help').length, 1);
  assert.equal(catalog.find((e) => e.name === 'help')!.source, 'session');
  const compile = catalog.find((e) => e.name === 'compile')!;
  assert.equal(compile.completes, 'path');
  assert.equal(compile.description, 'Compile one or more sources into XOIR and print a summary');
  assert.equal(catalog.find((e) => e.name === 'version')!.takesArgs, false);
});

test('closestMatch suggests by prefix or small edit distance, and stays quiet otherwise', () => {
  const names = ['compile', 'capabilities', 'create', 'verify'];
  assert.equal(closestMatch('compil', names), 'compile');
  assert.equal(closestMatch('verfy', names), 'verify');
  assert.equal(closestMatch('zzzzzz', names), undefined);
});

// ------------------------------------------------------------ completion

const catalog: CatalogEntry[] = [
  ...sessionCatalog(),
  { name: 'compile', description: 'Compile', usage: USAGE_COMPILE, args: '<source>...', completes: 'path', takesArgs: true, source: 'command' },
  { name: 'doctor', description: 'Check env', usage: 'xo doctor   Check env', completes: 'none', takesArgs: false, source: 'command' },
];
const fakeFs = {
  '/w': [{ name: 'docs', isDirectory: true }, { name: 'notes.txt', isDirectory: false }, { name: 'My File.pdf', isDirectory: false }, { name: '.hidden', isDirectory: false }, { name: 'node_modules', isDirectory: true }],
  '/w/docs': [{ name: 'a.pdf', isDirectory: false }],
};
const ctx: CompletionContext = {
  catalog,
  cwd: '/w',
  themes: ['xo-dark', 'dracula'],
  providers: ['anthropic', 'openai'],
  listDir: (dir) => {
    const entries = (fakeFs as Record<string, { name: string; isDirectory: boolean }[]>)[dir.replace(/\\/g, '/')];
    if (!entries) throw new Error('ENOENT');
    return entries;
  },
};

test('completion: slash command names by prefix, with args marked and no-arg commands marked runOnEnter', () => {
  const s = computeSuggestions('/com', 4, ctx)!;
  assert.deepEqual(s.items.map((i) => i.insert), ['/compile ']);
  assert.equal(s.from, 0);
  assert.equal(s.to, 4);
  assert.deepEqual(computeSuggestions('/co', 3, ctx)!.items.map((i) => i.label.split(' ')[0]).sort(), ['/compile', '/copy']);
  const d = computeSuggestions('/do', 3, ctx)!;
  assert.equal(d.items[0]!.insert, '/doctor');
  assert.equal(d.items[0]!.runOnEnter, true);
  assert.equal(d.items[0]!.kind, 'command');
  assert.ok(computeSuggestions('/', 1, ctx)!.items.length >= catalog.length);
  assert.equal(computeSuggestions('/zzz', 4, ctx), undefined);
  // Falls back to substring matches when nothing starts with the text.
  assert.ok(computeSuggestions('/ompi', 5, ctx)!.items.some((i) => i.insert.startsWith('/compile')));
});

test('completion: paths after a path command; hidden files and node_modules skipped; dirs first; spaces escaped', () => {
  const s = computeSuggestions('/compile ', 9, ctx)!;
  assert.deepEqual(s.items.map((i) => i.label), ['docs/', 'My File.pdf', 'notes.txt']);
  assert.equal(s.items.find((i) => i.label === 'My File.pdf')!.insert, 'My\\ File.pdf ');
  const sub = computeSuggestions('/compile docs/', 14, ctx)!;
  assert.deepEqual(sub.items.map((i) => i.insert), ['docs/a.pdf ']);
  assert.equal(computeSuggestions('/compile nothing', 16, ctx), undefined);
  // A leading dot opts in to hidden files.
  assert.deepEqual(computeSuggestions('/compile .', 10, ctx)!.items.map((i) => i.label), ['.hidden']);
});

test('completion: @ references complete anywhere, including plain-text prompts', () => {
  const s = computeSuggestions('summarize @no', 13, ctx)!;
  assert.deepEqual(s.items.map((i) => i.insert), ['@notes.txt ']);
  assert.equal(s.from, 10);
  assert.equal(computeSuggestions('no at sign here', 15, ctx), undefined);
});

test('completion: flags from usage, values for /theme, /provider, /help', () => {
  assert.deepEqual(computeSuggestions('/compile --do', 13, ctx)!.items.map((i) => i.label), ['--domain-hint']);
  assert.deepEqual(computeSuggestions('/theme dr', 9, ctx)!.items.map((i) => i.label), ['dracula']);
  assert.deepEqual(computeSuggestions('/provider o', 11, ctx)!.items.map((i) => i.label), ['openai']);
  assert.ok(computeSuggestions('/help com', 9, ctx)!.items.some((i) => i.label === 'compile'));
  assert.deepEqual(computeSuggestions('/doctor --st', 12, ctx), undefined);
});

test('completion: nothing inside quotes; path flags complete paths', () => {
  assert.equal(computeSuggestions('/compile "docs/', 15, ctx), undefined);
  assert.ok(computeSuggestions('/install x.xo --store ', 22, { ...ctx, catalog: [...catalog, { name: 'install', description: '', usage: 'xo install <a> --store <d>', completes: 'path', takesArgs: true, source: 'command' }] }));
});

// ------------------------------------------------------ history / settings

test('history: navigation, draft restore, dedupe, and persistence', async () => {
  await withTmp(async (dir) => {
    const h = new History(dir);
    h.add('one');
    h.add('two');
    h.add('two'); // consecutive duplicate ignored
    h.add('   '); // blank ignored
    assert.deepEqual(h.all, ['one', 'two']);
    assert.equal(h.previous('draft'), 'two');
    assert.equal(h.previous('ignored'), 'one');
    assert.equal(h.previous('ignored'), undefined); // at the oldest
    assert.equal(h.next(), 'two');
    assert.equal(h.next(), 'draft'); // walked off the end: the draft comes back
    assert.equal(h.next(), undefined);

    const reloaded = new History(dir);
    assert.deepEqual(reloaded.all, ['one', 'two']);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'history')).mode & 0o777, 0o600);
  });
});

test('history: multi-line entries round-trip, corrupt lines are skipped, size is capped', async () => {
  await withTmp(async (dir) => {
    const h = new History(dir);
    h.add('line1\nline2');
    assert.deepEqual(new History(dir).all, ['line1\nline2']);
    writeFileSync(join(dir, 'history'), `${JSON.stringify('ok')}\n{not json\n${JSON.stringify('also ok')}\n`);
    assert.deepEqual(new History(dir).all, ['ok', 'also ok']);
    const big = new History(dir);
    for (let i = 0; i < 700; i += 1) big.add(`cmd ${i}`);
    assert.equal(big.all.length, 500);
    assert.equal(big.all[499], 'cmd 699');
  });
});

test('history never writes an --api-key value to disk', async () => {
  assert.equal(redactForHistory('run x --api-key sk-secret --json'), 'run x --api-key *** --json');
  assert.equal(redactForHistory('run x --api-key=sk-secret'), 'run x --api-key=***');
  assert.equal(redactForHistory('run x --api-key "sk secret" y'), 'run x --api-key *** y');
  await withTmp(async (dir) => {
    const h = new History(dir);
    h.add('/run cap --input hi --api-key sk-very-secret');
    const onDisk = readFileSync(join(dir, 'history'), 'utf8');
    assert.doesNotMatch(onDisk, /sk-very-secret/);
    assert.match(onDisk, /--api-key \*\*\*/);
  });
});

test('settings: round-trip, removal via undefined, type validation, corrupt file tolerated', async () => {
  await withTmp(async (dir) => {
    const store = new SettingsStore(join(dir, 'home'));
    assert.deepEqual(store.load(), { settings: {} });
    assert.equal(store.save({ theme: 'dracula', storeDir: '/s', wittyPhrases: false }), undefined);
    assert.deepEqual(store.load().settings, { theme: 'dracula', storeDir: '/s', wittyPhrases: false });
    store.save({ storeDir: undefined, model: 'm1' });
    assert.deepEqual(store.load().settings, { theme: 'dracula', wittyPhrases: false, model: 'm1' });
    if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600);

    writeFileSync(store.path, JSON.stringify({ theme: 5, provider: 'openai', wittyPhrases: 'yes', junk: 1 }));
    assert.deepEqual(store.load().settings, { provider: 'openai' });

    writeFileSync(store.path, '{ nope');
    const bad = store.load();
    assert.deepEqual(bad.settings, {});
    assert.match(bad.warning!, /unreadable/);
    assert.equal(store.save({ theme: 'ansi' }), undefined, 'a corrupt file is replaced, not fatal');
    assert.deepEqual(store.load().settings, { theme: 'ansi' });
  });
});

test('settings never contain credentials: there is no key for one', () => {
  const src = readFileSync(new URL('../src/tui/settings.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /apiKey|api_key|password|token/i);
});

test('xoHome honors XO_HOME', () => {
  assert.equal(xoHome({ XO_HOME: '/x' }), '/x');
  assert.match(xoHome({}), /\.xo$/);
});

// ---------------------------------------------------------- misc helpers

test('shortenPath abbreviates home and elides the middle to fit', () => {
  assert.equal(shortenPath('/home/me/dev/xo', 40, '/home/me'), '~/dev/xo');
  const short = shortenPath('/a/very/long/path/that/keeps/going/until/deep', 24, '/nowhere');
  assert.ok(short.length <= 24, short);
  assert.match(short, /…/);
  assert.match(short, /deep$/);
});

test('readGitBranch reads HEAD from a .git directory, a worktree file, and a detached HEAD', async () => {
  await withTmp(async (dir) => {
    mkdirSync(join(dir, 'repo/.git'), { recursive: true });
    mkdirSync(join(dir, 'repo/src/deep'), { recursive: true });
    writeFileSync(join(dir, 'repo/.git/HEAD'), 'ref: refs/heads/feature/x\n');
    assert.equal(readGitBranch(join(dir, 'repo/src/deep')), 'feature/x');
    writeFileSync(join(dir, 'repo/.git/HEAD'), 'abcdef1234567890\n');
    assert.equal(readGitBranch(join(dir, 'repo')), 'abcdef1');
    mkdirSync(join(dir, 'wt'), { recursive: true });
    mkdirSync(join(dir, 'gitdirs/wt'), { recursive: true });
    writeFileSync(join(dir, 'gitdirs/wt/HEAD'), 'ref: refs/heads/wt-branch\n');
    writeFileSync(join(dir, 'wt/.git'), `gitdir: ${join(dir, 'gitdirs/wt')}\n`);
    assert.equal(readGitBranch(join(dir, 'wt')), 'wt-branch');
    assert.equal(existsSync(join(dir, 'nogit')), false);
  });
});

test('clipboardCommands picks the native tool per platform', () => {
  assert.deepEqual(clipboardCommands('darwin'), [['pbcopy']]);
  assert.deepEqual(clipboardCommands('win32'), [['clip']]);
  assert.ok(clipboardCommands('linux').some((c) => c[0] === 'xclip'));
});

test('captureOutput diverts stdout and stderr, restores both, and survives a throw', async () => {
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const ok = await captureOutput(async () => {
    process.stdout.write('out1\n');
    process.stderr.write('err1\n');
    console.log('via console');
    return 7;
  });
  assert.equal(ok.value, 7);
  assert.equal(ok.text, 'out1\nerr1\nvia console\n');
  assert.equal(process.stdout.write, realOut);
  assert.equal(process.stderr.write, realErr);

  const bad = await captureOutput(() => {
    process.stdout.write('before\n');
    throw new Error('boom');
  });
  assert.equal((bad.thrown as Error).message, 'boom');
  assert.equal(bad.text, 'before\n');
  assert.equal(process.stdout.write, realOut);
});

test('layoutBuffer wraps at the width, honors newlines, and places the cursor', () => {
  assert.deepEqual(layoutBuffer('', 0, 10), { rows: [''], cursorRow: 0, cursorCol: 0 });
  const l = layoutBuffer('abcdefghij', 10, 5);
  assert.deepEqual(l.rows, ['abcde', 'fghij', '']);
  assert.deepEqual([l.cursorRow, l.cursorCol], [2, 0]);
  const m = layoutBuffer('ab\ncd', 4, 10);
  assert.deepEqual(m.rows, ['ab', 'cd']);
  assert.deepEqual([m.cursorRow, m.cursorCol], [1, 1]);
  const mid = layoutBuffer('abcdefgh', 6, 5);
  assert.deepEqual([mid.cursorRow, mid.cursorCol], [1, 1]);
  const wide = layoutBuffer('漢字漢', 3, 4);
  assert.deepEqual(wide.rows, ['漢字', '漢']);
});

test('SessionState aggregates per-command stats; formatDuration is human-readable', () => {
  const s = new SessionState(0);
  s.record('compile', true, 1200);
  s.record('compile', false, 300);
  s.record('verify', true, 50);
  assert.deepEqual(s.totals, { count: 3, failed: 1, ms: 1550 });
  assert.equal(formatDuration(50), '50ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

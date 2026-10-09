import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger } from '@xo/logger';
import { buildRegistry, normalizeShortFlags, run, type TerminalIO } from '../src/index.js';
import { describeUsage } from '../src/tui/catalog.js';
import { stripAnsi } from '../src/tui/ansi.js';
import { sessionCatalog } from '../src/tui/slash-commands.js';
import { KEY, fakeTerminal, settle, withTmp } from './tui-helpers.js';

const quiet = new ConsoleLogger({ level: 'fatal' });

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((err += c), true)) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test('normalizeShortFlags expands aliases only before the command word (plus a lone trailing -h)', () => {
  assert.deepEqual(normalizeShortFlags(['-h']), ['--help']);
  assert.deepEqual(normalizeShortFlags(['-v']), ['--version']);
  assert.deepEqual(normalizeShortFlags(['-p', 'hi there']), ['--prompt', 'hi there']);
  assert.deepEqual(normalizeShortFlags(['-m', 'gpt-x', '-p', 'q', '--store', 's']), ['--model', 'gpt-x', '--prompt', 'q', '--store', 's']);
  assert.deepEqual(normalizeShortFlags(['--store', 's', '-p', 'q']), ['--store', 's', '--prompt', 'q']);
  assert.deepEqual(normalizeShortFlags(['-o', 'json', 'doctor']), ['--output-format', 'json', 'doctor']);
  assert.deepEqual(normalizeShortFlags(['compile', '-h']), ['compile', '--help']);
  // `init` owns --version and must be left alone; so must a -v/-p that is a *value* after the command.
  assert.deepEqual(normalizeShortFlags(['init', 'dir', '--version', '1.0.0']), ['init', 'dir', '--version', '1.0.0']);
  assert.deepEqual(normalizeShortFlags(['run', 'cap', '--input', '-p']), ['run', 'cap', '--input', '-p']);
  assert.deepEqual(normalizeShortFlags([]), []);
});

test('--version and -v print the package version', async () => {
  for (const argv of [['--version'], ['-v']]) {
    const r = await capture(() => run(argv, quiet));
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), `xo ${pkgVersion}`);
  }
});

test('`init --version` is still init\'s own flag, not the CLI version flag', async () => {
  const r = await capture(() => run(['init'], quiet)); // missing args -> init's own usage line, exit 1
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, new RegExp(`^xo ${pkgVersion}$`, 'm'));
});

test('--help (and -h) still print the global usage and now document interactive mode and the global options', async () => {
  for (const argv of [['--help'], ['-h'], []]) {
    const r = await capture(() => run(argv, quiet));
    assert.equal(r.code, 0);
    assert.match(r.out, /Experience Object platform CLI/);
    assert.match(r.out, /Interactive:/);
    assert.match(r.out, /xo -p "<text>"/);
    assert.match(r.out, /Global options:/);
    assert.match(r.out, /Exit codes:/);
  }
});

test('<command> --help / -h prints just that command\'s usage', async () => {
  for (const argv of [['compile', '--help'], ['compile', '-h']]) {
    const r = await capture(() => run(argv, quiet));
    assert.equal(r.code, 0);
    assert.match(r.out, /xo compile <source>/);
    assert.doesNotMatch(r.out, /Global options:/);
    assert.doesNotMatch(r.out, /xo verify/);
  }
});

test('an unknown command still exits 1 and prints usage, now with a did-you-mean hint', async () => {
  const r = await capture(() => run(['compil'], quiet));
  assert.equal(r.code, 1);
  assert.match(r.out, /Did you mean "compile"\?/);
  assert.match(r.out, /Experience Object platform CLI/);
  const none = await capture(() => run(['qqqqqqq'], quiet));
  assert.equal(none.code, 1);
  assert.doesNotMatch(none.out, /Did you mean/);
});

test('-o json is shorthand for --json; other formats are rejected', async () => {
  const bad = await capture(() => run(['-o', 'yaml', 'version'], quiet));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /--output-format must be "text" or "json"/);
  const ok = await capture(() => run(['-o', 'json', 'version'], quiet));
  assert.equal(ok.code, 0);
});

test('-p: needs text, needs a store, and never falls into the interactive session', async () => {
  await withTmp(async (dir) => {
    const prev = process.env['XO_HOME'];
    process.env['XO_HOME'] = join(dir, 'home'); // isolate from any real ~/.xo/settings.json
    try {
      const noText = await capture(() => run(['-p'], quiet));
      assert.equal(noText.code, 1);
      assert.match(noText.out, /needs the text to send/);
      const noStore = await capture(() => run(['-p', 'hello'], quiet));
      assert.equal(noStore.code, 1);
      assert.match(noStore.out, /needs a package store/);
    } finally {
      if (prev === undefined) delete process.env['XO_HOME'];
      else process.env['XO_HOME'] = prev;
    }
  });
});

test('without a terminal, `run([])` never starts the interactive session, even if the caller\'s own stdio is a TTY', async () => {
  const r = await capture(() => run([], quiet));
  assert.equal(r.code, 0);
  assert.match(r.out, /Experience Object platform CLI/);
});

test('with a non-TTY terminal, no command prints usage and -i is refused', async () => {
  const term = fakeTerminal();
  term.stdin.isTTY = false;
  const io: TerminalIO = { stdin: term.stdin, stdout: { ...term.stdout, isTTY: false } as never, env: {} };
  const usage = await capture(() => run([], quiet, { terminal: io }));
  assert.equal(usage.code, 0);
  assert.match(usage.out, /Experience Object platform CLI/);
  const refused = await capture(() => run(['-i', 'hello'], quiet, { terminal: io }));
  assert.equal(refused.code, 1);
  assert.match(refused.out, /needs a terminal/);
});

test('with a TTY terminal, `xo` with no command starts the session, runs a real registered command, and exits 0 on /quit', async () => {
  await withTmp(async (dir) => {
    const term = fakeTerminal(100);
    const io: TerminalIO = { stdin: term.stdin, stdout: term.stdout as never, env: { XO_HOME: join(dir, 'home'), NO_COLOR: '1' } };
    const done = run([], quiet, { terminal: io });
    await settle();
    assert.match(term.plain(), /Experience Object platform CLI · v/);
    for (const ch of '/version') await term.send(ch);
    await term.send(KEY.enter);
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    assert.match(term.plain(), new RegExp(`✓ version`));
    assert.match(term.plain(), new RegExp(`xo ${pkgVersion.replace(/\./g, '\\.')}`));
    for (const ch of '/quit') await term.send(ch);
    await term.send(KEY.enter);
    assert.equal(await done, 0);
    assert.equal(term.stdin.rawMode, false);
  });
});

test('--help with a TTY terminal prints usage instead of starting the session', async () => {
  const term = fakeTerminal();
  const io: TerminalIO = { stdin: term.stdin, stdout: term.stdout as never, env: { NO_COLOR: '1' } };
  const r = await capture(() => run(['--help'], quiet, { terminal: io }));
  assert.equal(r.code, 0);
  assert.match(r.out, /Interactive:/);
  assert.equal(term.stdin.rawMode, false);
});

test('one-shot output is colorized on a color TTY, and stripping the colors gives exactly the plain output', async () => {
  const plain = await capture(() => run(['doctor'], quiet));
  const term = fakeTerminal();
  const colored = await capture(() => run(['doctor'], quiet, { terminal: { stdin: term.stdin, stdout: term.stdout as never, env: { COLORTERM: 'truecolor' } } }));
  assert.equal(colored.code, plain.code);
  assert.match(colored.out, /\u001b\[/);
  assert.equal(stripAnsi(colored.out), plain.out);

  const noColor = await capture(() => run(['doctor', '--no-color'], quiet, { terminal: { stdin: term.stdin, stdout: term.stdout as never, env: { COLORTERM: 'truecolor' } } }));
  assert.equal(noColor.out, plain.out);
  const envOff = await capture(() => run(['doctor'], quiet, { terminal: { stdin: term.stdin, stdout: term.stdout as never, env: { COLORTERM: 'truecolor', NO_COLOR: '1' } } }));
  assert.equal(envOff.out, plain.out);
});

test('--json output is never touched by the colorizer', async () => {
  const term = fakeTerminal();
  const io: TerminalIO = { stdin: term.stdin, stdout: term.stdout as never, env: { COLORTERM: 'truecolor' } };
  const r = await capture(() => run(['version', '--json'], quiet, { terminal: io }));
  assert.doesNotMatch(r.out, /\u001b\[/);
});

test('every registered command has a description the session menu can show', () => {
  const registry = buildRegistry();
  const missing: string[] = [];
  for (const { commands } of registry.listBySubsystem().values()) {
    for (const c of commands) if (describeUsage(c.usage) === '') missing.push(c.name);
  }
  assert.deepEqual(missing, [], `commands whose usage string has no parsable description: ${missing.join(', ')}`);
});

test('no registered command shares a name with a session command (which would silently shadow it)', () => {
  const registry = buildRegistry();
  const registered = new Set([...registry.listBySubsystem().values()].flatMap((s) => s.commands.map((c) => c.name)));
  const clashes = sessionCatalog().filter((e) => registered.has(e.name)).map((e) => e.name);
  assert.deepEqual(clashes, []);
});

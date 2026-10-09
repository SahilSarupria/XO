import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger } from '@xo/logger';
import { CommandRegistry } from '../src/command-registry.js';
import { startRepl, type QueryRequest, type ReplDeps } from '../src/tui/repl.js';
import { KEY, fakeTerminal, settle, withTmp, type FakeTerminal } from './tui-helpers.js';

function buildRegistry(): { registry: CommandRegistry; calls: { name: string; args: unknown }[] } {
  const registry = new CommandRegistry();
  const calls: { name: string; args: unknown }[] = [];
  registry.register({
    name: 'echo',
    subsystem: 'test',
    usage: 'xo echo <text>...                        Print the arguments',
    run: (args) => {
      calls.push({ name: 'echo', args });
      process.stdout.write(`${args.positionals.join(' ')}\n`);
      return 0;
    },
  });
  registry.register({
    name: 'boom',
    subsystem: 'test',
    usage: 'xo boom                                 Always fails',
    run: () => {
      process.stdout.write('error: it broke\n');
      return 1;
    },
  });
  registry.register({
    name: 'throws',
    subsystem: 'test',
    usage: 'xo throws                               Throws',
    run: () => {
      throw new Error('kaboom');
    },
  });
  registry.register({
    name: 'install',
    subsystem: 'test',
    usage: 'xo install <archive.xo> --store <dir>\n                                         Fake install',
    run: (args) => {
      calls.push({ name: 'install', args });
      process.stdout.write(`store=${String(args.flags['store'])}\n`);
      return 0;
    },
  });
  registry.register({
    name: 'search',
    subsystem: 'test',
    usage: 'xo search <q> --registry <dir>',
    run: (args) => {
      calls.push({ name: 'search', args });
      process.stdout.write(`registry=${String(args.flags['registry'])}\n`);
      return 0;
    },
  });
  registry.register({
    name: 'json',
    subsystem: 'test',
    usage: 'xo json                                 Emits JSON',
    run: () => {
      process.stdout.write(`${JSON.stringify({ status: 'completed', n: 1 })}\n`);
      return 0;
    },
  });
  return { registry, calls };
}

interface Harness {
  term: FakeTerminal;
  done: Promise<number>;
  requests: QueryRequest[];
  calls: { name: string; args: unknown }[];
  home: string;
  submit(line: string): Promise<void>;
}

async function start(dir: string, overrides: Partial<ReplDeps> = {}): Promise<Harness> {
  const term = fakeTerminal(90);
  const { registry, calls } = buildRegistry();
  const requests: QueryRequest[] = [];
  const home = join(dir, 'home');
  const done = startRepl({
    registry,
    logger: new ConsoleLogger({ level: 'fatal' }),
    stdin: term.stdin,
    stdout: term.stdout,
    env: {},
    version: '9.9.9',
    colorLevel: 0,
    providers: ['anthropic', 'openai', 'ollama'],
    home,
    runQuery: async (req) => {
      requests.push(req);
      return { exitCode: 0, lines: ['Here is **the answer**.', '', '- point one', '', '--- receipt ---', '  tokens: 12 prompt + 3 completion'] };
    },
    ...overrides,
  });
  await settle();
  return {
    term,
    done,
    requests,
    calls,
    home,
    submit: async (line) => {
      await term.send(line);
      await term.send(KEY.enter);
      await new Promise((r) => setTimeout(r, 30));
      await settle();
    },
  };
}

async function quit(h: Harness): Promise<void> {
  await h.submit('/quit');
  assert.equal(await h.done, 0);
}

test('the session shows the banner and prompt, runs /quit, prints a summary, and restores the terminal', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    assert.match(h.term.plain(), /Experience Object platform CLI · v9\.9\.9/);
    assert.match(h.term.plain(), /Tips for getting started/);
    assert.equal(h.term.stdin.rawMode, true);
    await quit(h);
    assert.match(h.term.plain(), /Goodbye/);
    assert.match(h.term.plain(), /commands run\s+1/);
    assert.equal(h.term.stdin.rawMode, false);
    assert.match(h.term.raw(), /\u001b\[\?2004l/);
  });
});

test('a /command runs the registered command and shows its output in a ✓ box with a duration', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/echo hello   world');
    const plain = h.term.plain();
    assert.match(plain, /╭─ ✓ echo hello {3}world ─+╮/);
    assert.match(plain, /│ hello world\s+│/);
    assert.match(plain, /╰─+ \d+ms ─╯/);
    assert.equal(h.calls.length, 1);
    await quit(h);
  });
});

test('a failing command (non-zero exit) gets a ✗ box; a throwing command is reported, never crashes the session', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/boom');
    assert.match(h.term.plain(), /╭─ ✗ boom/);
    assert.match(h.term.plain(), /error: it broke/);
    await h.submit('/throws');
    assert.match(h.term.plain(), /✗ throws/);
    assert.match(h.term.plain(), /error: kaboom/);
    await h.submit('/echo still alive');
    assert.match(h.term.plain(), /✓ echo still alive/);
    await quit(h);
  });
});

test('real stdout/stderr writers are restored after every command', async () => {
  await withTmp(async (dir) => {
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const h = await start(dir);
    await h.submit('/echo x');
    await h.submit('/throws');
    assert.equal(process.stdout.write, realOut);
    assert.equal(process.stderr.write, realErr);
    await quit(h);
  });
});

test('unknown commands get a did-you-mean hint; quoting errors are reported', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/ecoh hi');
    assert.match(h.term.plain(), /unknown command "\/ecoh"\s+— did you mean \/echo\?/);
    await h.submit('/echo "unterminated');
    assert.match(h.term.plain(), /unterminated " quote/);
    await quit(h);
  });
});

test('--help after a command shows that command\'s usage without running it', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/echo --help');
    assert.match(h.term.plain(), /Print the arguments/);
    assert.equal(h.calls.length, 0);
    await h.submit('/help echo');
    assert.match(h.term.plain(), /\/echo <text>/);
    await quit(h);
  });
});

test('/help lists session and XO commands; /help <unknown> errors', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/help');
    const plain = h.term.plain();
    assert.match(plain, /Session commands/);
    assert.match(plain, /XO commands/);
    assert.match(plain, /\/theme \[name\]/);
    assert.match(plain, /\/echo <text>\.\.\.\s+Print the arguments/);
    assert.match(plain, /Shortcuts/);
    await h.submit('/help nothing-like-this');
    assert.match(h.term.plain(), /no such command "nothing-like-this"/);
    await quit(h);
  });
});

test('/theme lists themes, switches, persists, and rejects unknown names', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/theme');
    assert.match(h.term.plain(), /xo-dark[^\n]*Default dark theme/);
    await h.submit('/theme dracula');
    assert.match(h.term.plain(), /Theme set to dracula/);
    assert.equal(JSON.parse(readFileSync(join(h.home, 'settings.json'), 'utf8')).theme, 'dracula');
    await h.submit('/theme nonsense');
    assert.match(h.term.plain(), /unknown theme "nonsense"/);
    await quit(h);

    // A later session starts with the saved theme.
    const h2 = await start(dir);
    await h2.submit('/theme');
    assert.match(h2.term.plain(), /✓ dracula/);
    await quit(h2);
  });
});

test('/store and /reg set, persist, and clear directories; session defaults are injected into commands that take them', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    const store = join(dir, 'my-store');
    const reg = join(dir, 'my-reg');
    mkdirSync(store);
    await h.submit(`/store ${store}`);
    await h.submit(`/reg ${reg}`);
    assert.match(h.term.plain(), /does not exist yet/);
    const saved = JSON.parse(readFileSync(join(h.home, 'settings.json'), 'utf8'));
    assert.equal(saved.storeDir, store);
    assert.equal(saved.registryDir, reg);

    await h.submit('/install pkg.xo');
    assert.match(h.term.plain(), new RegExp(`note: using session store ${store.replace(/[/\\.]/g, '.')}`));
    assert.match(h.term.plain(), new RegExp(`store=${store.replace(/[/\\.]/g, '.')}`));
    await h.submit('/search claims');
    assert.match(h.term.plain(), /registry=/);

    // An explicit flag wins over the session default.
    await h.submit('/install pkg.xo --store /explicit');
    assert.match(h.term.plain(), /store=\/explicit/);
    assert.doesNotMatch(h.term.plain().split('store=/explicit')[1] ?? '', /note: using session store/);

    await h.submit('/store none');
    assert.equal(JSON.parse(readFileSync(join(h.home, 'settings.json'), 'utf8')).storeDir, undefined);
    await quit(h);
  });
});

test('@file arguments are stripped only when the file exists', async () => {
  await withTmp(async (dir) => {
    const prev = process.cwd();
    writeFileSync(join(dir, 'real.txt'), 'x');
    process.chdir(dir);
    try {
      const h = await start(dir);
      await h.submit('/echo @real.txt @ghost.txt');
      assert.match(h.term.plain(), /│ real\.txt @ghost\.txt/);
      await quit(h);
    } finally {
      process.chdir(prev);
    }
  });
});

test('plain text without a store explains what to do and does not call the model', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('what claims need approval?');
    assert.match(h.term.plain(), /no package store set/);
    assert.equal(h.requests.length, 0);
    await quit(h);
  });
});

test('plain text with a store becomes a query: answer rendered, receipt dimmed, request shaped correctly', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit(`/store ${dir}`);
    await h.submit('/provider openai');
    await h.submit('/model gpt-x');
    await h.submit('what claims need approval?');
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0], { query: 'what claims need approval?', input: 'what claims need approval?', storeDir: dir, provider: 'openai', model: 'gpt-x' });
    const plain = h.term.plain();
    assert.match(plain, /✦ Here is \*\*the answer\*\*\./); // level 0: markdown markers are left as written
    assert.match(plain, /• point one/);
    assert.match(plain, /tokens: 12 prompt \+ 3 completion/);
    assert.doesNotMatch(plain, /--- receipt ---/);
    await quit(h);
  });
});

test('a failed query is shown in a ✗ box; a throwing runQuery is reported, not fatal', async () => {
  await withTmp(async (dir) => {
    let mode: 'fail' | 'throw' = 'fail';
    const h = await start(dir, {
      runQuery: async () => {
        if (mode === 'throw') throw new Error('provider exploded');
        return { exitCode: 1, lines: ['error: anthropic provider needs an API key — pass --api-key or set ANTHROPIC_API_KEY'] };
      },
    });
    await h.submit(`/store ${dir}`);
    await h.submit('hello');
    assert.match(h.term.plain(), /✗ query/);
    assert.match(h.term.plain(), /needs an API key/);
    mode = 'throw';
    await h.submit('again');
    assert.match(h.term.plain(), /provider exploded/);
    await h.submit('/echo ok');
    assert.match(h.term.plain(), /✓ echo ok/);
    await quit(h);
  });
});

test('@file in a query attaches text files, and skips binary or missing ones with a note', async () => {
  await withTmp(async (dir) => {
    const prev = process.cwd();
    writeFileSync(join(dir, 'claim.txt'), 'Claim amount 15000, flood.');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    process.chdir(dir);
    try {
      const h = await start(dir);
      await h.submit(`/store ${dir}`);
      await h.submit('assess @claim.txt and @blob.bin and @missing.txt');
      const req = h.requests[0]!;
      assert.equal(req.query, 'assess @claim.txt and @blob.bin and @missing.txt');
      assert.match(req.input, /--- claim\.txt ---\nClaim amount 15000, flood\./);
      assert.doesNotMatch(req.input, /blob\.bin ---/);
      assert.match(h.term.plain(), /attached @claim\.txt/);
      assert.match(h.term.plain(), /skipped @blob\.bin: binary file/);
      await quit(h);
    } finally {
      process.chdir(prev);
    }
  });
});

test('! runs a shell command in a box and reports its exit status', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('!echo from-the-shell');
    assert.match(h.term.plain(), /╭─ ✓ ! echo from-the-shell/);
    assert.match(h.term.plain(), /│ from-the-shell/);
    await h.submit('!exit 3');
    assert.match(h.term.plain(), /✗ ! exit 3/);
    await quit(h);
  });
});

test('/stats and /about render; /copy with nothing to copy says so; /clear does not crash', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/copy');
    assert.match(h.term.plain(), /Nothing to copy yet/);
    await h.submit('/echo one');
    await h.submit('/stats');
    assert.match(h.term.plain(), /Session stats/);
    assert.match(h.term.plain(), /echo\s+1×/);
    await h.submit('/about');
    assert.match(h.term.plain(), /About xo/);
    assert.match(h.term.plain(), /v9\.9\.9/);
    await h.submit('/clear');
    await quit(h);
  });
});

test('/provider validates names and reports whether the key env var is set — without ever showing it', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir, { env: { OPENAI_API_KEY: 'sk-SECRET-VALUE' } });
    await h.submit('/provider bogus');
    assert.match(h.term.plain(), /unknown provider "bogus"/);
    await h.submit('/provider openai');
    await h.submit('/provider');
    assert.match(h.term.plain(), /OPENAI_API_KEY is set/);
    await h.submit('/about');
    assert.doesNotMatch(h.term.raw(), /sk-SECRET-VALUE/);
    await quit(h);
  });
});

test('/settings witty off persists; /cd changes and validates the directory', async () => {
  await withTmp(async (dir) => {
    const prev = process.cwd();
    try {
      const h = await start(dir);
      await h.submit('/settings witty off');
      assert.equal(JSON.parse(readFileSync(join(h.home, 'settings.json'), 'utf8')).wittyPhrases, false);
      mkdirSync(join(dir, 'sub'));
      await h.submit(`/cd ${join(dir, 'sub')}`);
      assert.match(process.cwd().replace(/\\/g, '/'), /sub$/);
      await h.submit('/cd /definitely/not/here');
      assert.match(h.term.plain(), /cannot change directory/);
      await quit(h);
    } finally {
      process.chdir(prev);
    }
  });
});

test('an initial prompt (xo -i) is echoed and executed before the first read', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir, { initialPrompt: '/echo from -i' });
    assert.match(h.term.plain(), /│ > \/echo from -i/);
    assert.match(h.term.plain(), /✓ echo from -i/);
    await quit(h);
  });
});

test('color: with a color level the output carries escapes, and stripping them yields the plain rendering', async () => {
  await withTmp(async (dir) => {
    const colored = await start(join(dir, 'a'), { colorLevel: 3 });
    await colored.submit('/boom');
    assert.match(colored.term.raw(), /\u001b\[38;2;/);
    await quit(colored);
    const plain = await start(join(dir, 'b'), { colorLevel: 0 });
    await plain.submit('/boom');
    assert.doesNotMatch(plain.term.raw().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''), /\u001b/);
    await quit(plain);
  });
});

test('JSON output from a command is pretty-printed inside the box', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir);
    await h.submit('/json');
    assert.match(h.term.plain(), /│ \{\s+│/);
    assert.match(h.term.plain(), /│ {3}"status": "completed",/);
    await quit(h);
  });
});

test('Ctrl+C twice while a command runs calls exit(130) and restores the terminal', async () => {
  await withTmp(async (dir) => {
    const exits: number[] = [];
    const registry = new CommandRegistry();
    let release: () => void = () => undefined;
    registry.register({
      name: 'slow',
      subsystem: 't',
      usage: 'xo slow',
      run: () => new Promise<number>((res) => (release = () => res(0))),
    });
    const term = fakeTerminal(80);
    const done = startRepl({
      registry,
      logger: new ConsoleLogger({ level: 'fatal' }),
      stdin: term.stdin,
      stdout: term.stdout,
      env: {},
      version: '1',
      colorLevel: 0,
      providers: [],
      home: join(dir, 'home'),
      runQuery: async () => ({ exitCode: 0, lines: [] }),
      exit: (code) => void exits.push(code),
    });
    await settle();
    await term.send('/slow');
    await term.send(KEY.enter);
    await settle();
    await term.send(KEY.ctrlC);
    assert.deepEqual(exits, []);
    await term.send(KEY.ctrlC);
    assert.deepEqual(exits, [130]);
    assert.equal(term.stdin.rawMode, false);
    release();
    await settle();
    // Session is over once the (injected, non-terminating) exit hook returns; end it cleanly.
    await term.send('/quit');
    await term.send(KEY.enter);
    await done.catch(() => undefined);
  });
});

test('settings files never hold anything but preferences after a full session', async () => {
  await withTmp(async (dir) => {
    const h = await start(dir, { env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET' } });
    await h.submit('/theme ansi');
    await h.submit('/provider anthropic');
    await h.submit('/run cap --api-key sk-ant-SECRET');
    await quit(h);
    for (const file of ['settings.json', 'history']) {
      const p = join(h.home, file);
      if (existsSync(p)) assert.doesNotMatch(readFileSync(p, 'utf8'), /sk-ant-SECRET/, file);
    }
  });
});

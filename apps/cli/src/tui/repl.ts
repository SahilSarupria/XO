import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from '@xo/logger';
import { parseArgs, type ParsedArgs } from '../arg-parser.js';
import type { CommandRegistry } from '../command-registry.js';
import type { CommandResult } from '../command-result.js';
import { stripAnsi, wrapAnsi, type ColorLevel, createPainter } from './ansi.js';
import { renderBanner } from './banner.js';
import { renderBox } from './box.js';
import { REGISTRY_COMMANDS, STORE_COMMANDS, buildCatalog, closestMatch } from './catalog.js';
import { captureOutput } from './capture.js';
import { computeSuggestions } from './completion.js';
import { copyToClipboard, readGitBranch, shortenPath } from './env-info.js';
import { highlightOutput } from './highlight.js';
import { History } from './history.js';
import { PromptEditor, type EditorInput, type EditorOutput } from './input.js';
import { renderMarkdown } from './markdown.js';
import { SessionState, formatDuration } from './session.js';
import { SettingsStore } from './settings.js';
import { findSessionCommand, sessionCatalog, type ReplContext } from './slash-commands.js';
import { Spinner } from './spinner.js';
import { DEFAULT_THEME, THEMES, createUi, findTheme, type Theme } from './theme.js';
import { stripAtPrefix, tokenize } from './tokenize.js';

/** A natural-language request against the installed XOs — what plain text in the session (and `xo -p`) turns into. */
export interface QueryRequest {
  readonly query: string;
  readonly input: string;
  readonly storeDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly json?: boolean;
  readonly providerFlags?: { readonly apiKey?: string; readonly baseUrl?: string; readonly endpoint?: string; readonly apiVersion?: string };
}

export interface ReplOutput extends EditorOutput {
  readonly isTTY?: boolean;
}

export interface ReplDeps {
  readonly registry: CommandRegistry;
  readonly logger: Logger;
  readonly stdin: EditorInput;
  readonly stdout: ReplOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly colorLevel: ColorLevel;
  readonly providers: readonly string[];
  readonly runQuery: (request: QueryRequest) => Promise<CommandResult>;
  /** Directory holding settings.json and history (`~/.xo` unless XO_HOME is set). */
  readonly home: string;
  /** From `xo -i "<prompt>"`: submitted automatically once the banner is shown. */
  readonly initialPrompt?: string;
  /** Session overrides from command-line flags; win over saved settings. */
  readonly defaults?: { readonly store?: string; readonly registry?: string; readonly provider?: string; readonly model?: string };
  /** Called when Ctrl+C is pressed twice while a command is running. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

const MAX_ATTACH_BYTES = 200 * 1024;

/**
 * The interactive session. It owns the terminal (prompt editor, spinner,
 * boxes) and delegates all real work: every `/command` is looked up in
 * the same {@link CommandRegistry} one-shot `xo <command>` uses and run
 * with its output diverted into a status box — no command is aware it is
 * running inside a session, and none was modified for it.
 */
export async function startRepl(deps: ReplDeps): Promise<number> {
  const { registry, logger, stdout } = deps;
  const rawWrite = stdout.write.bind(stdout) as (chunk: string) => unknown;
  const term: EditorOutput = {
    write: (s) => rawWrite(s),
    get columns() {
      return stdout.columns;
    },
    on: (event, listener) => stdout.on?.(event, listener),
    removeListener: (event, listener) => stdout.removeListener?.(event, listener),
  };

  const settings = new SettingsStore(deps.home);
  const loaded = settings.load();
  const session = new SessionState();
  session.storeDir = deps.defaults?.store !== undefined ? resolve(deps.defaults.store) : loaded.settings.storeDir;
  session.registryDir = deps.defaults?.registry !== undefined ? resolve(deps.defaults.registry) : loaded.settings.registryDir;
  session.provider = deps.defaults?.provider ?? loaded.settings.provider;
  session.model = deps.defaults?.model ?? loaded.settings.model;
  session.witty = loaded.settings.wittyPhrases ?? true;

  const painter = createPainter(deps.colorLevel);
  let theme: Theme = findTheme(loaded.settings.theme ?? '') ?? DEFAULT_THEME;
  let ui = createUi(theme, painter);
  let done = false;

  const catalog = buildCatalog(registry, sessionCatalog());
  const cols = (): number => Math.max(40, stdout.columns ?? 80);
  const print = (lines: readonly string[]): void => {
    if (lines.length > 0) rawWrite(`${lines.join('\n')}\n`);
  };

  const branchCache = { cwd: '', at: 0, value: undefined as string | undefined };
  const branch = (): string | undefined => {
    const cwd = process.cwd();
    if (branchCache.cwd !== cwd || Date.now() - branchCache.at > 5000) {
      branchCache.cwd = cwd;
      branchCache.at = Date.now();
      branchCache.value = readGitBranch(cwd);
    }
    return branchCache.value;
  };

  const history = new History(deps.home);
  const editor = new PromptEditor({
    input: deps.stdin,
    output: term,
    ui: () => ui,
    history,
    suggest: (buffer, cursor) =>
      computeSuggestions(buffer, cursor, { catalog, cwd: process.cwd(), themes: THEMES.map((t) => t.name), providers: deps.providers }),
    footer: () => {
      const b = branch();
      const room = Math.max(12, Math.floor(cols() * 0.4));
      return {
        left: `${shortenPath(process.cwd(), room)}${b ? ` (${b})` : ''}`,
        center: session.storeDir ? `store ${shortenPath(session.storeDir, 28)}` : 'no store set',
        right: `${session.provider ?? 'anthropic'}${session.model ? ` · ${session.model}` : ''}`,
      };
    },
  });

  const ctx: ReplContext = {
    ui: () => ui,
    session,
    settings,
    version: deps.version,
    providers: deps.providers,
    env: deps.env,
    catalog: () => catalog,
    cwd: () => process.cwd(),
    width: cols,
    print,
    applyTheme: (t) => {
      theme = t;
      ui = createUi(theme, painter);
    },
    clear: () => editor.clearScreen(),
    exit: () => {
      done = true;
    },
    copy: (text) => copyToClipboard(text, (s) => void rawWrite(s)),
    chdir: (dir) => {
      const target = resolve(process.cwd(), dir);
      try {
        if (!statSync(target).isDirectory()) return `not a directory: ${target}`;
        process.chdir(target);
        return undefined;
      } catch (cause) {
        return `cannot change directory to ${target}: ${(cause as Error).message}`;
      }
    },
  };

  // Built per run so /theme and /settings witty apply to the very next command.
  const newSpinner = (): Spinner => new Spinner({ ui, write: (s) => void rawWrite(s), columns: cols, enabled: stdout.isTTY === true, witty: session.witty });

  // ------------------------------------------------------------ execution

  interface Outcome {
    readonly exitCode: number;
    readonly text: string;
    readonly ms: number;
  }

  async function execute(label: string, work: () => Promise<{ exitCode: number; text: string }>): Promise<Outcome> {
    const sp = newSpinner();
    sp.start(label);
    editor.beginBusy((presses) => {
      if (presses >= 2) {
        sp.stop();
        editor.close();
        rawWrite('\n');
        (deps.exit ?? ((code: number) => process.exit(code)))(130);
      } else {
        sp.setNote('press ctrl+c again to quit');
      }
    });
    const t0 = Date.now();
    try {
      const r = await work();
      return { ...r, ms: Date.now() - t0 };
    } finally {
      editor.endBusy();
      sp.stop();
    }
  }

  function showResult(label: string, name: string, outcome: Outcome, highlight = true): void {
    const ok = outcome.exitCode === 0;
    const icon = ok ? ui.success('✓') : ui.error('✗');
    const lines = outcome.text.trim() === '' ? [ui.muted('(no output)')] : highlight ? highlightOutput(outcome.text, ui) : outcome.text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    print(
      renderBox(lines, {
        width: cols(),
        title: `${icon} ${painter.bold(label)}`,
        footer: ui.muted(formatDuration(outcome.ms)),
        borderColor: (t) => painter.fg(ok ? theme.border : theme.error, t),
      }),
    );
    session.lastOutput = stripAnsi(outcome.text);
    session.record(name, ok, outcome.ms);
  }

  function applySessionDefaults(name: string, args: ParsedArgs): { args: ParsedArgs; notes: string[] } {
    const flags: Record<string, string | boolean> = { ...args.flags };
    const flagLists: Record<string, string[]> = Object.fromEntries(Object.entries(args.flagLists).map(([k, v]) => [k, [...v]]));
    const notes: string[] = [];
    const inject = (flag: string, value: string, what: string): void => {
      flags[flag] = value;
      flagLists[flag] = [value];
      notes.push(`note: using session ${what} ${value}`);
    };
    const first = args.positionals[0] ?? '';
    const installedRef = name === 'inspect' && /^[^/\\]+@[^/\\]+$/.test(first) && !first.endsWith('.xo');
    if ((STORE_COMMANDS.has(name) || installedRef) && flags['store'] === undefined && session.storeDir) inject('store', session.storeDir, 'store');
    if (REGISTRY_COMMANDS.has(name) && flags['registry'] === undefined && session.registryDir) inject('registry', session.registryDir, 'registry');
    return { args: { ...args, flags, flagLists }, notes };
  }

  async function runRegistryCommand(name: string, tokens: readonly string[], typed: string): Promise<void> {
    const command = registry.get(name);
    if (!command) return;
    // "@file" is a picker convention; strip it only when it names something that exists.
    const cleaned = tokens.map((t) => (t.startsWith('@') && existsSync(resolve(process.cwd(), stripAtPrefix(t))) ? stripAtPrefix(t) : t));
    const parsed = parseArgs([name, ...cleaned]);
    if (parsed.flags['help'] === true) {
      const entry = catalog.find((e) => e.name === name);
      print(['', painter.bold(ui.primary(`/${name}`)), '', ...(entry?.usage ?? command.usage).split('\n').map((l) => `  ${l}`), '']);
      return;
    }
    const { args, notes } = applySessionDefaults(name, parsed);
    const outcome = await execute(typed, async () => {
      const cap = await captureOutput(() => command.run(args, { logger }));
      const code = cap.thrown !== undefined ? 1 : typeof cap.value === 'number' ? cap.value : 0;
      const thrown = cap.thrown !== undefined ? `error: ${(cap.thrown as Error)?.message ?? String(cap.thrown)}\n` : '';
      return { exitCode: code, text: `${notes.map((n) => `${n}\n`).join('')}${cap.text}${thrown}` };
    });
    showResult(typed, name, outcome);
  }

  async function runShell(cmd: string): Promise<void> {
    const outcome = await execute(`! ${cmd}`, () => new Promise((res) => {
      let text = '';
      const child = spawn(cmd, { shell: true, cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d: Buffer) => (text += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (text += d.toString('utf8')));
      child.on('error', (e) => res({ exitCode: 1, text: `${text}error: ${e.message}\n` }));
      child.on('close', (code) => res({ exitCode: code ?? 1, text }));
    }));
    showResult(`! ${cmd}`, 'shell', outcome, false);
  }

  function attachFiles(text: string): { input: string; notes: string[] } {
    const notes: string[] = [];
    const blocks: string[] = [];
    for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
      const rel = m[1]!;
      const abs = resolve(process.cwd(), rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const size = statSync(abs).size;
      if (size > MAX_ATTACH_BYTES) {
        notes.push(`skipped @${rel}: larger than ${MAX_ATTACH_BYTES / 1024} KB`);
        continue;
      }
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8192).includes(0)) {
        notes.push(`skipped @${rel}: binary file (use /compile to process documents)`);
        continue;
      }
      blocks.push(`--- ${rel} ---\n${buf.toString('utf8')}`);
      notes.push(`attached @${rel} (${Math.max(1, Math.round(size / 1024))} KB)`);
    }
    return { input: blocks.length > 0 ? `${text}\n\n${blocks.join('\n\n')}` : text, notes };
  }

  async function runPlainQuery(text: string): Promise<void> {
    if (!session.storeDir) {
      print(
        [
          `${painter.bold(ui.error('error:'))} ${ui.error('no package store set.')}`,
          ui.muted('  Plain text queries your installed XOs. Point the session at a store with /store <dir> (packages land there via /install <archive.xo>), and make sure a provider API key is set — see /provider.'),
        ].flatMap((l) => wrapAnsi(l, cols() - 1)),
      );
      session.record('query', false, 0);
      return;
    }
    const { input, notes } = attachFiles(text);
    for (const n of notes) print([ui.muted(`  ${n}`)]);
    const outcome = await execute('query', async () => {
      const cap = await captureOutput(() =>
        deps.runQuery({
          query: text,
          input,
          storeDir: session.storeDir!,
          ...(session.provider !== undefined ? { provider: session.provider } : {}),
          ...(session.model !== undefined ? { model: session.model } : {}),
        }),
      );
      if (cap.thrown !== undefined) return { exitCode: 1, text: `error: ${(cap.thrown as Error)?.message ?? String(cap.thrown)}\n` };
      const result = cap.value!;
      return { exitCode: result.exitCode, text: `${cap.text}${result.lines.join('\n')}\n` };
    });

    if (outcome.exitCode !== 0) return showResult('query', 'query', outcome);

    const lines = outcome.text.replace(/\n+$/, '').split('\n');
    const receiptAt = lines.indexOf('--- receipt ---');
    const body = receiptAt === -1 ? lines : lines.slice(0, receiptAt);
    const receipt = receiptAt === -1 ? [] : lines.slice(receiptAt + 1);
    const warnings = body.filter((l) => l.startsWith('warning:'));
    const message = body.filter((l) => !l.startsWith('warning:')).join('\n').trim();

    print(warnings.map((w) => ui.warning(w)));
    const rendered = renderMarkdown(message, ui).flatMap((l) => wrapAnsi(l, cols() - 2));
    print(rendered.map((l, i) => `${i === 0 ? ui.accent('✦') : ' '} ${l}`));
    if (receipt.length > 0) print(['', ...receipt.map((l) => ui.muted(`  ${l.trim()}`))]);
    print(['']);
    session.lastOutput = message;
    session.record('query', true, outcome.ms);
  }

  async function runSlash(text: string): Promise<void> {
    const parsed = tokenize(text.slice(1));
    if (parsed.unterminatedQuote) {
      print([`${painter.bold(ui.error('error:'))} ${ui.error(`unterminated ${parsed.unterminatedQuote} quote`)}`]);
      return;
    }
    const [rawName, ...rest] = parsed.tokens;
    const name = (rawName ?? 'help').toLowerCase();
    const sessionCommand = findSessionCommand(name);
    if (sessionCommand) {
      const t0 = Date.now();
      let ok = true;
      try {
        await sessionCommand.run(rest, ctx);
      } catch (cause) {
        ok = false;
        print([`${painter.bold(ui.error('error:'))} ${ui.error((cause as Error).message)}`]);
      }
      session.record(sessionCommand.name, ok, Date.now() - t0);
      return;
    }
    if (registry.get(name)) return runRegistryCommand(name, rest, text.slice(1).trim());
    const hint = closestMatch(name, catalog.map((e) => e.name));
    print([`${painter.bold(ui.error('error:'))} ${ui.error(`unknown command "/${name}"`)}${hint ? ui.muted(`  — did you mean /${hint}?`) : ui.muted('  — /help lists all commands')}`]);
  }

  async function dispatch(line: string, shell: boolean): Promise<void> {
    const text = line.trim();
    if (text === '') return;
    if (shell) return runShell(text);
    if (text === '/') return runSlash('/help');
    if (text.startsWith('/')) return runSlash(text);
    return runPlainQuery(text);
  }

  function echoPrompt(text: string): void {
    print(renderBox([`${painter.bold(ui.primary('>'))} ${ui.muted(text)}`], { width: cols(), borderColor: (t) => ui.border(t) }));
  }

  function summary(): void {
    const t = session.totals;
    print([
      '',
      ...renderBox(
        [
          `${ui.muted('session      ')} ${formatDuration(Date.now() - session.startedAt)}`,
          `${ui.muted('commands run ')} ${t.count}${t.failed > 0 ? ui.error(`  (${t.failed} failed)`) : ''}`,
        ],
        { width: Math.min(cols(), 60), title: painter.bold(ui.primary('Goodbye')), borderColor: (x) => ui.border(x) },
      ),
      '',
    ]);
  }

  // ------------------------------------------------------------ main loop

  const restore = (): void => editor.close();
  const onTerm = (): void => {
    editor.close();
    process.exit(143);
  };
  process.once('exit', restore);
  process.once('SIGTERM', onTerm);

  try {
    editor.open();
    print(renderBanner(ui, deps.version, cols()));
    if (loaded.warning) print([ui.warning(`warning: ${loaded.warning}`), '']);

    let pending = deps.initialPrompt;
    while (!done) {
      let text: string;
      let shell = false;
      if (pending !== undefined) {
        text = pending;
        pending = undefined;
        echoPrompt(text);
        history.add(text);
      } else {
        const result = await editor.read();
        if (result.kind === 'exit') break;
        text = result.text;
        shell = result.shell;
      }
      await dispatch(text, shell);
    }
  } finally {
    summary();
    editor.close();
    process.removeListener('exit', restore);
    process.removeListener('SIGTERM', onTerm);
  }
  return 0;
}


import { ConsoleLogger, type Logger } from '@xo/logger';
import { parseArgs, type ParsedArgs } from './arg-parser.js';
import { CommandRegistry } from './command-registry.js';
import { registerCommands as registerSystemCommands } from './commands/system/index.js';
import { registerCommands as registerPackageCommands } from './commands/package/index.js';
import { registerCommands as registerCompilerCommands } from './commands/compiler/index.js';
import { registerCommands as registerRuntimeCommands } from './commands/runtime/index.js';
import { registerCommands as registerRegistryCommands } from './commands/registry/index.js';
import { registerCommands as registerBenchmarkCommands } from './commands/benchmark/index.js';
import { registerCommands as registerAiCommands } from './commands/ai/index.js';
import { versionCommand } from './commands/system/version.js';
import { SUPPORTED_PROVIDER_IDS } from './commands/runtime/provider-factory.js';
import { createPainter, detectColorLevel, type ColorLevel } from './tui/ansi.js';
import { closestMatch } from './tui/catalog.js';
import { highlightLine } from './tui/highlight.js';
import { readPipedStdin, runPromptMode, type StdinLike } from './tui/prompt-mode.js';
import { runQuery } from './tui/query.js';
import { startRepl, type ReplOutput } from './tui/repl.js';
import { xoHome } from './tui/settings.js';
import { DEFAULT_THEME, createUi } from './tui/theme.js';
import type { EditorInput } from './tui/input.js';

/**
 * The only place that knows the full list of subsystems. It knows
 * nothing about any individual *command* — that knowledge lives entirely
 * inside each subsystem's own `registerCommands()`. Adding a command to
 * an existing subsystem never touches this function; adding a whole new
 * subsystem means adding one import + one call here, and nothing else in
 * this file changes.
 */
export function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerSystemCommands(registry);
  registerPackageCommands(registry);
  registerCompilerCommands(registry);
  registerRuntimeCommands(registry);
  registerRegistryCommands(registry);
  registerBenchmarkCommands(registry);
  registerAiCommands(registry);
  return registry;
}

function usage(registry: CommandRegistry): string {
  const sections: string[] = [];
  for (const [subsystem, { description, commands }] of registry.listBySubsystem()) {
    if (commands.length === 0) {
      sections.push(`  ${subsystem}:\n    (no commands yet${description ? ` — ${description}` : ''})`);
      continue;
    }
    const lines = commands
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `    ${c.usage}`)
      .join('\n');
    sections.push(`  ${subsystem}:\n${lines}`);
  }

  return [
    'xo — Experience Object platform CLI',
    '',
    'Usage:',
    sections.join('\n\n'),
    '',
    'Interactive:',
    '  xo                                      Start the interactive session (needs a terminal)',
    '  xo -i "<text>"                          Start the session and submit <text> first',
    '  xo -p "<text>" --store <dir>            Non-interactive: send a natural-language query to the XOs in <dir>',
    '                                          (piped stdin is appended: cat claim.txt | xo -p "assess this")',
    '',
    'Global options:',
    '  -h, --help                              Show this message (or, after a command, that command\'s usage)',
    '  -v, --version                           Print the CLI version',
    '  -m, --model <id>  --provider <id>       Model/provider for -p and session queries',
    '  -o, --output-format text|json           json is shorthand for a command\'s --json',
    '  --no-color                              Disable colors (NO_COLOR and non-terminal output also disable them)',
    '',
    'Exit codes: 0 on success; 1 on any failure, including "verify" reporting',
    'INVALID or "diff" reporting an UNSAFE upgrade plan — both are meant to be',
    'used as CI gates (`xo verify pkg.xo || exit 1`).',
  ].join('\n');
}

function commandUsage(usageText: string): string {
  return ['Usage:', `  ${usageText.trim()}`, '', 'Run `xo --help` for every command and the global options.'].join('\n');
}

// --------------------------------------------------------------- terminal

/** Everything terminal-dependent, passed in explicitly so nothing in `run()` reads `process.std*` implicitly. `bin/xo.js` supplies the real ones; tests supply fakes (or nothing, which keeps `run()` exactly the plain, non-TTY function it always was). */
export interface TerminalIO {
  readonly stdin: EditorInput & StdinLike;
  readonly stdout: ReplOutput & { getColorDepth?: () => number };
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RunOptions {
  /** Enables interactive mode, colored output, and piped-stdin reading for `-p`. Omitted (the default) means plain output and no interactivity — what library callers and the test suite get. */
  readonly terminal?: TerminalIO;
}

const SHORT_FLAGS: Readonly<Record<string, string>> = {
  '-h': '--help',
  '-v': '--version',
  '-p': '--prompt',
  '-i': '--prompt-interactive',
  '-m': '--model',
  '-o': '--output-format',
};
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--prompt', '--prompt-interactive', '--model', '--output-format']);

/**
 * Expands the short aliases above, but only in the run of flags *before*
 * the command word (so `xo init dir --version 1.0.0` is untouched — `init`
 * owns `--version`), plus a lone trailing `-h` (`xo compile -h`).
 */
export function normalizeShortFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    const long = SHORT_FLAGS[token];
    if (long !== undefined) {
      out.push(long);
      i += 1;
      if (VALUE_FLAGS.has(long) && i < argv.length) {
        out.push(argv[i]!);
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--')) {
      out.push(token);
      i += 1;
      const next = argv[i];
      if (next !== undefined && !next.startsWith('-')) {
        out.push(next);
        i += 1;
      }
      continue;
    }
    break;
  }
  out.push(...argv.slice(i));
  if (out.length > 1 && out[out.length - 1] === '-h') out[out.length - 1] = '--help';
  return out;
}

function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** Runs `fn` with each complete line written to stdout passed through the highlighter (terminal, color on, non-JSON output only). */
async function withHighlightedStdout<T>(level: ColorLevel, fn: () => Promise<T>): Promise<T> {
  const ui = createUi(DEFAULT_THEME, createPainter(level));
  const real = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string' && chunk.endsWith('\n')) {
      const styled = chunk
        .slice(0, -1)
        .split('\n')
        .map((line) => (/^\s*[{[]/.test(line) ? line : highlightLine(line, ui)))
        .join('\n');
      return (real as (...a: unknown[]) => boolean).call(process.stdout, `${styled}\n`, ...rest);
    }
    return (real as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = real;
  }
}

export async function run(argv: readonly string[], logger: Logger = new ConsoleLogger({ level: 'info', name: 'xo-cli' }), options: RunOptions = {}): Promise<number> {
  const registry = buildRegistry();
  const parsed = parseArgs(normalizeShortFlags(argv));
  const term = options.terminal;

  // `-o json` is shorthand for the per-command `--json` every structured command already has.
  const outputFormat = str(parsed.flags, 'output-format');
  if (outputFormat !== undefined && outputFormat !== 'text' && outputFormat !== 'json') {
    process.stdout.write(`error: --output-format must be "text" or "json" (got "${outputFormat}")\n`);
    return 1;
  }
  const args: ParsedArgs = outputFormat === 'json' ? { ...parsed, flags: { ...parsed.flags, json: true } } : parsed;

  const colorLevel: ColorLevel = term && args.flags['no-color'] !== true ? detectColorLevel(term.stdout, term.env) : 0;
  const jsonMode = args.flags['json'] === true;
  const home = xoHome(term?.env ?? process.env);

  const providerFlags = {
    ...(str(args.flags, 'api-key') !== undefined ? { apiKey: str(args.flags, 'api-key')! } : {}),
    ...(str(args.flags, 'base-url') !== undefined ? { baseUrl: str(args.flags, 'base-url')! } : {}),
    ...(str(args.flags, 'endpoint') !== undefined ? { endpoint: str(args.flags, 'endpoint')! } : {}),
    ...(str(args.flags, 'api-version') !== undefined ? { apiVersion: str(args.flags, 'api-version')! } : {}),
  };

  if (args.command === undefined) {
    if (args.flags['version'] === true) {
      process.stdout.write(`${versionCommand()}\n`);
      return 0;
    }

    if (args.flags['prompt'] !== undefined) {
      const prompt = str(args.flags, 'prompt');
      if (prompt === undefined || prompt.trim() === '') {
        process.stdout.write('error: -p/--prompt needs the text to send, e.g. xo -p "which claims need a manager?" --store ./store\n');
        return 1;
      }
      return runPromptMode({
        prompt,
        stdinText: term ? await readPipedStdin(term.stdin) : undefined,
        storeFlag: str(args.flags, 'store'),
        provider: str(args.flags, 'provider'),
        model: str(args.flags, 'model'),
        providerFlags,
        json: jsonMode,
        home,
        runQuery,
        stdout: (t) => void process.stdout.write(t),
        stderr: (t) => void process.stderr.write(t),
      });
    }

    const interactiveAvailable = term !== undefined && term.stdin.isTTY === true && term.stdout.isTTY === true;
    const wantsInteractive = args.flags['prompt-interactive'] !== undefined || (args.flags['help'] !== true && interactiveAvailable);
    if (wantsInteractive) {
      if (!interactiveAvailable || !term) {
        process.stdout.write('error: the interactive session needs a terminal (stdin and stdout must be TTYs); use `xo <command>` or `xo -p "<text>"` in scripts\n');
        return 1;
      }
      const initial = str(args.flags, 'prompt-interactive');
      return startRepl({
        registry,
        logger,
        stdin: term.stdin,
        stdout: term.stdout,
        env: term.env,
        version: versionCommand().replace(/^xo /, ''),
        colorLevel,
        providers: SUPPORTED_PROVIDER_IDS,
        runQuery,
        home,
        ...(initial !== undefined && initial.trim() !== '' ? { initialPrompt: initial } : {}),
        defaults: {
          ...(str(args.flags, 'store') !== undefined ? { store: str(args.flags, 'store')! } : {}),
          ...(str(args.flags, 'registry') !== undefined ? { registry: str(args.flags, 'registry')! } : {}),
          ...(str(args.flags, 'provider') !== undefined ? { provider: str(args.flags, 'provider')! } : {}),
          ...(str(args.flags, 'model') !== undefined ? { model: str(args.flags, 'model')! } : {}),
        },
      });
    }
  }

  const highlight = colorLevel > 0 && !jsonMode;
  const printUsage = (text: string): Promise<void> => (highlight ? withHighlightedStdout(colorLevel, async () => void process.stdout.write(`${text}\n`)) : Promise.resolve(void process.stdout.write(`${text}\n`)));

  if (args.command === undefined || args.flags['help'] === true) {
    const command = args.command !== undefined ? registry.get(args.command) : undefined;
    await printUsage(command ? commandUsage(command.usage) : usage(registry));
    return 0;
  }

  const command = registry.get(args.command);
  if (!command) {
    logger.error('Unknown command', { command: args.command });
    const hint = closestMatch(args.command, [...registry.listBySubsystem().values()].flatMap((s) => s.commands.map((c) => c.name)));
    if (hint) process.stdout.write(`Did you mean "${hint}"?\n\n`);
    await printUsage(usage(registry));
    return 1;
  }

  if (highlight) return withHighlightedStdout(colorLevel, async () => command.run(args, { logger }));
  return command.run(args, { logger });
}

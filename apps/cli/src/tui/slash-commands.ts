import { existsSync, statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { truncate, visibleLength } from './ansi.js';
import { renderBox } from './box.js';
import type { CatalogEntry } from './catalog.js';
import { PROVIDER_KEY_ENV, formatDuration, type SessionState } from './session.js';
import type { CopyResult } from './env-info.js';
import { shortenPath } from './env-info.js';
import type { SettingsStore } from './settings.js';
import { THEMES, findTheme, type Theme, type Ui } from './theme.js';

/** What a session command may do to the running session. Deliberately narrow: commands never touch the terminal or the editor directly. */
export interface ReplContext {
  ui(): Ui;
  readonly session: SessionState;
  readonly settings: SettingsStore;
  readonly version: string;
  readonly providers: readonly string[];
  catalog(): readonly CatalogEntry[];
  cwd(): string;
  width(): number;
  /** Prints already-styled lines followed by a newline. */
  print(lines: readonly string[]): void;
  applyTheme(theme: Theme): void;
  clear(): void;
  exit(): void;
  copy(text: string): Promise<CopyResult>;
  chdir(dir: string): string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

export interface SessionCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly args?: string;
  readonly completes: CatalogEntry['completes'];
  run(args: readonly string[], ctx: ReplContext): Promise<void> | void;
}

const err = (ctx: ReplContext, message: string): void => ctx.print([`${ctx.ui().painter.bold(ctx.ui().error('error:'))} ${ctx.ui().error(message)}`]);
const info = (ctx: ReplContext, message: string): void => ctx.print([ctx.ui().muted(message)]);

function persist(ctx: ReplContext, patch: Parameters<SettingsStore['save']>[0]): void {
  const problem = ctx.settings.save(patch);
  if (problem) ctx.print([ctx.ui().warning(`warning: ${problem}`)]);
}

function setDir(ctx: ReplContext, label: string, key: 'storeDir' | 'registryDir', args: readonly string[], noun: string): void {
  const ui = ctx.ui();
  const current = ctx.session[key];
  if (args.length === 0) {
    ctx.print([current ? `${label}: ${ui.accent(current)}` : ui.muted(`No ${noun} set. Use /${label === 'store' ? 'store' : 'reg'} <dir> to set one.`)]);
    return;
  }
  if (args[0] === '--clear' || args[0] === 'none') {
    ctx.session[key] = undefined;
    persist(ctx, { [key]: undefined });
    ctx.print([ui.muted(`${label} cleared.`)]);
    return;
  }
  const abs = resolve(ctx.cwd(), args.join(' '));
  ctx.session[key] = abs;
  persist(ctx, { [key]: abs });
  const exists = existsSync(abs) && statSync(abs).isDirectory();
  ctx.print([`${label} set to ${ui.accent(abs)}${exists ? '' : ui.warning('  (directory does not exist yet)')}`]);
}

export const SESSION_COMMANDS: readonly SessionCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show all commands, or usage for one command',
    usage: '/help [command]',
    args: '[command]',
    completes: 'command',
    run: (args, ctx) => {
      const ui = ctx.ui();
      const catalog = ctx.catalog();
      if (args[0] !== undefined) {
        const name = args[0].replace(/^\//, '');
        const entry = catalog.find((e) => e.name === name || (e.source === 'session' && SESSION_COMMANDS.find((c) => c.name === e.name)?.aliases?.includes(name)));
        if (!entry) return err(ctx, `no such command "${name}" — /help lists them all`);
        const shown = entry.source === 'command' ? entry.usage.replace(/^ {0,4}xo /gm, '/').replace(/^ {6,}(?=\S)/gm, '    ') : entry.usage;
        ctx.print(['', ui.painter.bold(ui.primary(`/${entry.name}`)), '', ...shown.split('\n').map((l) => `  ${l}`), '']);
        return;
      }
      const width = ctx.width();
      const row = (e: CatalogEntry): string => {
        const label = `/${e.name}${e.args ? ` ${e.args}` : ''}`;
        const shownLabel = truncate(label, 28);
        const pad = 30 - visibleLength(shownLabel);
        return truncate(`  ${ui.accent(shownLabel)}${' '.repeat(pad)}${ui.muted(e.description)}`, width - 1);
      };
      const session = catalog.filter((e) => e.source === 'session');
      const commands = catalog.filter((e) => e.source === 'command');
      ctx.print([
        '',
        ui.painter.bold('Session commands'),
        ...session.map(row),
        '',
        ui.painter.bold('XO commands') + ui.muted('  (same as `xo <command>`; session store/registry are filled in for you)'),
        ...commands.map(row),
        '',
        ui.painter.bold('Shortcuts'),
        `  ${ui.accent('@')}            ${ui.muted('file picker: type @ then Tab (e.g. /compile @policy.pdf)')}`,
        `  ${ui.accent('!')}            ${ui.muted('shell mode: !ls -la runs a shell command (Esc to leave)')}`,
        `  ${ui.accent('plain text')}   ${ui.muted('queries your installed XOs (needs /store and a provider API key)')}`,
        `  ${ui.accent('↑ / ↓')}        ${ui.muted('history · Ctrl+J or \\+Enter for a new line · Ctrl+L clear')}`,
        `  ${ui.accent('Ctrl+C')}       ${ui.muted('clear the line; press twice on an empty line to exit (also Ctrl+D)')}`,
        '',
      ]);
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the screen (Ctrl+L)',
    usage: '/clear',
    completes: 'none',
    run: (_a, ctx) => ctx.clear(),
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Exit the session',
    usage: '/quit',
    completes: 'none',
    run: (_a, ctx) => ctx.exit(),
  },
  {
    name: 'about',
    description: 'Show version, environment, and session settings',
    usage: '/about',
    completes: 'none',
    run: (_a, ctx) => {
      const ui = ctx.ui();
      const s = ctx.session;
      const keyEnv = PROVIDER_KEY_ENV[s.provider ?? 'anthropic'];
      const keyState = keyEnv === undefined ? 'no key needed' : ctx.env[keyEnv] ? `${keyEnv} is set` : `${keyEnv} is NOT set`;
      const rows: [string, string][] = [
        ['xo', `v${ctx.version}`],
        ['node', `${process.versions.node} (${platform()} ${release()} ${arch()})`],
        ['cwd', ctx.cwd()],
        ['store', s.storeDir ?? '(not set)'],
        ['registry', s.registryDir ?? '(not set)'],
        ['provider', `${s.provider ?? 'anthropic'}${s.model ? ` · ${s.model}` : ''}  —  ${keyState}`],
        ['theme', ui.theme.name],
        ['settings', ctx.settings.path],
      ];
      const w = Math.max(...rows.map(([k]) => k.length));
      ctx.print(['', ...renderBox(rows.map(([k, v]) => `${ui.muted(k.padEnd(w))}  ${v}`), { width: Math.min(ctx.width(), 100), title: ui.painter.bold(ui.primary('About xo')), borderColor: (t) => ui.border(t) }), '']);
    },
  },
  {
    name: 'theme',
    description: 'List or change the color theme',
    usage: '/theme [name]',
    args: '[name]',
    completes: 'theme',
    run: (args, ctx) => {
      const ui = ctx.ui();
      if (args[0] === undefined) {
        ctx.print([
          '',
          ...THEMES.map((t) => {
            const swatch = [t.primary, t.accent, t.success, t.warning, t.error].map((c) => ui.painter.fg(c, '●')).join(' ');
            const mark = t.name === ui.theme.name ? ui.success('✓') : ' ';
            return ` ${mark} ${ui.accent(t.name.padEnd(12))} ${swatch}  ${ui.muted(t.description)}`;
          }),
          '',
          ui.muted('  /theme <name> to switch'),
          '',
        ]);
        return;
      }
      const theme = findTheme(args[0]);
      if (!theme) return err(ctx, `unknown theme "${args[0]}" — available: ${THEMES.map((t) => t.name).join(', ')}`);
      ctx.applyTheme(theme);
      persist(ctx, { theme: theme.name });
      ctx.print([`Theme set to ${ctx.ui().accent(theme.name)}.`]);
    },
  },
  {
    name: 'store',
    description: 'Show or set the package store used by install/run/queries',
    usage: '/store [dir | none]',
    args: '[dir]',
    completes: 'path',
    run: (args, ctx) => setDir(ctx, 'store', 'storeDir', args, 'package store'),
  },
  {
    name: 'reg',
    description: 'Show or set the local registry used by publish/search',
    usage: '/reg [dir | none]',
    args: '[dir]',
    completes: 'path',
    run: (args, ctx) => setDir(ctx, 'registry', 'registryDir', args, 'local registry'),
  },
  {
    name: 'provider',
    description: 'Show or set the model provider for queries',
    usage: '/provider [anthropic|openai|azure-openai|gemini|ollama]',
    args: '[name]',
    completes: 'provider',
    run: (args, ctx) => {
      const ui = ctx.ui();
      if (args[0] === undefined) {
        const p = ctx.session.provider ?? 'anthropic';
        const keyEnv = PROVIDER_KEY_ENV[p];
        const state = keyEnv === undefined ? 'no API key needed' : ctx.env[keyEnv] ? `${keyEnv} is set` : `${keyEnv} is not set`;
        ctx.print([`provider: ${ui.accent(p)}${ctx.session.provider ? '' : ui.muted(' (default)')}  ${ui.muted(`— ${state}`)}`, ui.muted(`available: ${ctx.providers.join(', ')}`)]);
        return;
      }
      if (!ctx.providers.includes(args[0])) return err(ctx, `unknown provider "${args[0]}" — available: ${ctx.providers.join(', ')}`);
      ctx.session.provider = args[0];
      persist(ctx, { provider: args[0] });
      ctx.print([`provider set to ${ui.accent(args[0])}. ${ui.muted('API keys are read from the environment, never stored.')}`]);
    },
  },
  {
    name: 'model',
    description: "Show or set the model id sent to the provider",
    usage: '/model [id | default]',
    args: '[id]',
    completes: 'none',
    run: (args, ctx) => {
      const ui = ctx.ui();
      if (args[0] === undefined) {
        ctx.print([ctx.session.model ? `model: ${ui.accent(ctx.session.model)}` : ui.muted("model: (provider default)")]);
        return;
      }
      if (args[0] === 'default') {
        ctx.session.model = undefined;
        persist(ctx, { model: undefined });
        ctx.print([ui.muted('model reset to the provider default.')]);
        return;
      }
      ctx.session.model = args[0];
      persist(ctx, { model: args[0] });
      ctx.print([`model set to ${ui.accent(args[0])}.`]);
    },
  },
  {
    name: 'cd',
    description: 'Change the working directory for this session',
    usage: '/cd <dir>',
    args: '<dir>',
    completes: 'path',
    run: (args, ctx) => {
      if (args[0] === undefined) return ctx.print([ctx.ui().muted(`cwd: ${ctx.cwd()}`)]);
      const problem = ctx.chdir(args.join(' '));
      if (problem) return err(ctx, problem);
      ctx.print([`cwd: ${ctx.ui().accent(shortenPath(ctx.cwd(), ctx.width() - 8))}`]);
    },
  },
  {
    name: 'stats',
    description: 'Show session duration and per-command timings',
    usage: '/stats',
    completes: 'none',
    run: (_a, ctx) => {
      const ui = ctx.ui();
      const t = ctx.session.totals;
      const rows: string[] = [
        `${ui.muted('session      ')} ${formatDuration(Date.now() - ctx.session.startedAt)}`,
        `${ui.muted('commands run ')} ${t.count}${t.failed > 0 ? ui.error(`  (${t.failed} failed)`) : ''}`,
        `${ui.muted('time in cmds ')} ${formatDuration(t.ms)}`,
      ];
      if (ctx.session.stats.size > 0) {
        rows.push('', ui.painter.bold('By command'));
        for (const [name, s] of [...ctx.session.stats.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
          rows.push(`  ${ui.accent(name.padEnd(14))} ${String(s.count).padStart(3)}×  ${formatDuration(s.ms).padStart(8)}${s.failed > 0 ? ui.error(`  ${s.failed} failed`) : ''}`);
        }
      }
      ctx.print(['', ...renderBox(rows, { width: Math.min(ctx.width(), 72), title: ui.painter.bold(ui.primary('Session stats')), borderColor: (x) => ui.border(x) }), '']);
    },
  },
  {
    name: 'copy',
    description: 'Copy the last command output to the clipboard',
    usage: '/copy',
    completes: 'none',
    run: async (_a, ctx) => {
      if (ctx.session.lastOutput === '') return info(ctx, 'Nothing to copy yet — run a command first.');
      const r = await ctx.copy(ctx.session.lastOutput);
      ctx.print([r.ok ? ctx.ui().muted(`Copied last output via ${r.method}.`) : ctx.ui().warning('Could not copy to the clipboard.')]);
    },
  },
  {
    name: 'settings',
    description: 'Show saved preferences; `/settings witty on|off` toggles spinner phrases',
    usage: '/settings [witty on|off]',
    args: '[witty on|off]',
    completes: 'none',
    run: (args, ctx) => {
      const ui = ctx.ui();
      if (args[0] === 'witty') {
        if (args[1] !== 'on' && args[1] !== 'off') return err(ctx, 'usage: /settings witty on|off');
        ctx.session.witty = args[1] === 'on';
        persist(ctx, { wittyPhrases: ctx.session.witty });
        ctx.print([`Spinner phrases ${args[1]}.`]);
        return;
      }
      const s = ctx.session;
      ctx.print([
        '',
        `${ui.muted('file      ')} ${ctx.settings.path}`,
        `${ui.muted('theme     ')} ${ui.theme.name}`,
        `${ui.muted('store     ')} ${s.storeDir ?? '(not set)'}`,
        `${ui.muted('registry  ')} ${s.registryDir ?? '(not set)'}`,
        `${ui.muted('provider  ')} ${s.provider ?? '(default: anthropic)'}`,
        `${ui.muted('model     ')} ${s.model ?? '(provider default)'}`,
        `${ui.muted('witty     ')} ${s.witty ? 'on' : 'off'}`,
        '',
        ui.muted('API keys are never saved here — set them in your environment.'),
        '',
      ]);
    },
  },
];

export function findSessionCommand(name: string): SessionCommand | undefined {
  return SESSION_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export function sessionCatalog(): CatalogEntry[] {
  return SESSION_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    usage: c.usage,
    ...(c.args !== undefined ? { args: c.args } : {}),
    completes: c.completes,
    takesArgs: c.args !== undefined,
    source: 'session' as const,
  }));
}

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { PATH_FLAGS, flagsFromUsage, type CatalogEntry } from './catalog.js';

export interface Suggestion {
  /** What the menu shows. */
  readonly label: string;
  /** Replaces buffer[from, to) when accepted. */
  readonly insert: string;
  readonly description?: string;
  /** `command` = a slash-command name (Enter accepts it); the rest complete arguments (Enter submits the line as typed, Tab completes). */
  readonly kind: 'command' | 'path' | 'value' | 'flag';
  /** True when accepting this suggestion finishes the token (a trailing space was added). */
  readonly complete: boolean;
  /** Pressing Enter on this suggestion should accept it *and* submit the line (a session/CLI command that takes no arguments). */
  readonly runOnEnter?: boolean;
}

export interface SuggestionSet {
  readonly items: readonly Suggestion[];
  readonly from: number;
  readonly to: number;
}

export interface CompletionContext {
  readonly catalog: readonly CatalogEntry[];
  readonly cwd: string;
  readonly themes: readonly string[];
  readonly providers: readonly string[];
  /** Injectable for tests. */
  readonly listDir?: (dir: string) => readonly { name: string; isDirectory: boolean }[];
}

const MAX_ITEMS = 100;

function defaultListDir(dir: string): { name: string; isDirectory: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(resolve(dir, d.name))) }));
}

function safeIsDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Escapes spaces so a completed path survives the session's tokenizer. */
function escapeSpaces(s: string): string {
  return s.replace(/ /g, '\\ ');
}

function unescapeSpaces(s: string): string {
  return s.replace(/\\ /g, ' ');
}

/** Finds the start of the whitespace-delimited token ending at `cursor` (a backslash-escaped space does not end a token). */
function tokenStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0) {
    const ch = text[i - 1]!;
    if (/\s/.test(ch) && text[i - 2] !== '\\') break;
    i -= 1;
  }
  return i;
}

export function completePaths(partial: string, prefix: string, ctx: CompletionContext, from: number, to: number): SuggestionSet | undefined {
  const raw = unescapeSpaces(partial);
  const home = homedir();
  const expanded = raw === '~' ? `${home}${sep}` : raw.startsWith('~/') || raw.startsWith(`~${sep}`) ? home + raw.slice(1) : raw;
  const cut = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf(sep));
  const dirPart = cut >= 0 ? expanded.slice(0, cut + 1) : '';
  const base = cut >= 0 ? expanded.slice(cut + 1) : expanded;
  const typedDirPart = (() => {
    const c = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf(sep));
    return c >= 0 ? raw.slice(0, c + 1) : '';
  })();

  let entries: readonly { name: string; isDirectory: boolean }[];
  try {
    entries = (ctx.listDir ?? defaultListDir)(resolve(ctx.cwd, dirPart === '' ? '.' : dirPart));
  } catch {
    return undefined;
  }

  const showHidden = base.startsWith('.');
  const lowerBase = base.toLowerCase();
  const caseInsensitive = base === lowerBase;
  const matches = entries
    .filter((e) => (showHidden || !e.name.startsWith('.')) && e.name !== 'node_modules')
    .filter((e) => (caseInsensitive ? e.name.toLowerCase() : e.name).startsWith(caseInsensitive ? lowerBase : base))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
    .slice(0, MAX_ITEMS);
  if (matches.length === 0) return undefined;

  return {
    from,
    to,
    items: matches.map((e) => ({
      label: e.isDirectory ? `${e.name}/` : e.name,
      kind: 'path' as const,
      insert: `${prefix}${escapeSpaces(typedDirPart)}${escapeSpaces(e.name)}${e.isDirectory ? '/' : ' '}`,
      complete: !e.isDirectory,
    })),
  };
}

/**
 * Computes what the suggestion menu should show for the text before
 * `cursor`. Pure function of (buffer, cursor, context) so it is testable
 * without a terminal. Returns undefined when nothing applies.
 */
export function computeSuggestions(buffer: string, cursor: number, ctx: CompletionContext): SuggestionSet | undefined {
  const lineStart = buffer.lastIndexOf('\n', cursor - 1) + 1;
  const before = buffer.slice(lineStart, cursor);
  const start = tokenStart(buffer, cursor);
  const token = buffer.slice(start, cursor);
  if (/["']/.test(token)) return undefined;

  const isSlashLine = lineStart === 0 && buffer.startsWith('/');

  if (isSlashLine && !/\s/.test(before)) {
    const q = before.slice(1).toLowerCase();
    const byPrefix = ctx.catalog.filter((e) => e.name.startsWith(q));
    const matches = byPrefix.length > 0 ? byPrefix : ctx.catalog.filter((e) => e.name.includes(q));
    if (matches.length === 0) return undefined;
    return {
      from: 0,
      to: cursor,
      items: matches.map((e) => ({
        label: `/${e.name}${e.args ? ` ${e.args}` : ''}`,
        insert: `/${e.name}${e.takesArgs ? ' ' : ''}`,
        description: e.description,
        kind: 'command' as const,
        complete: e.takesArgs,
        ...(e.takesArgs ? {} : { runOnEnter: true }),
      })),
    };
  }

  if (isSlashLine) {
    const words = before.trimStart().split(/\s+/);
    const commandName = words[0]!.slice(1);
    const entry = ctx.catalog.find((e) => e.name === commandName);
    const previous = tokenBefore(buffer, start);

    if (token.startsWith('-') && entry) {
      const flags = flagsFromUsage(entry.usage).filter((f) => f.startsWith(token));
      if (flags.length === 0) return undefined;
      return { from: start, to: cursor, items: flags.map((f) => ({ label: f, insert: `${f} `, kind: 'flag' as const, complete: true })) };
    }
    if (previous !== undefined && PATH_FLAGS.has(previous)) return completePaths(token, '', ctx, start, cursor);
    if (previous === '--provider' || commandName === 'provider') return valueSet(ctx.providers, token, start, cursor);
    if (commandName === 'theme') return valueSet(ctx.themes, token, start, cursor);
    if (commandName === 'help') {
      const names = ctx.catalog.map((e) => e.name);
      return valueSet(names, token, start, cursor);
    }
    if (token.startsWith('@')) return completePaths(token.slice(1), '@', ctx, start, cursor);
    if (entry?.completes === 'path') return completePaths(token, '', ctx, start, cursor);
    return undefined;
  }

  if (token.startsWith('@')) return completePaths(token.slice(1), '@', ctx, start, cursor);
  return undefined;
}

function tokenBefore(buffer: string, tokenStartIndex: number): string | undefined {
  const head = buffer.slice(0, tokenStartIndex).trimEnd();
  if (head === '') return undefined;
  const s = tokenStart(head, head.length);
  return head.slice(s);
}

function valueSet(values: readonly string[], token: string, from: number, to: number): SuggestionSet | undefined {
  const matches = values.filter((v) => v.startsWith(token));
  if (matches.length === 0) return undefined;
  return { from, to, items: matches.map((v) => ({ label: v, insert: `${v} `, kind: 'value' as const, complete: true })) };
}

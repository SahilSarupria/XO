import type { CommandRegistry } from '../command-registry.js';

export type CompletionKind = 'path' | 'command' | 'theme' | 'provider' | 'none';

/** One entry in the slash-command menu / `/help` — either a session command or a passthrough to a registered `xo` command. */
export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  /** Short argument hint shown in the menu, e.g. `<file|dir|.zip>`. */
  readonly args?: string;
  readonly completes: CompletionKind;
  readonly takesArgs: boolean;
  readonly source: 'session' | 'command';
}

/** Commands whose first positional is a filesystem path (drives Tab-completion). */
export const PATH_COMMANDS: ReadonlySet<string> = new Set([
  'compile', 'capabilities', 'create', 'workflow', 'inspect', 'verify', 'install', 'pack', 'build', 'init', 'diff', 'fingerprint', 'publish',
]);

/** Flags whose value is a path, for Tab-completion after them. */
export const PATH_FLAGS: ReadonlySet<string> = new Set(['--store', '--registry', '--out', '--key-out']);

/** Commands that take `--store <dir>` — the session store is injected when the flag is omitted. */
export const STORE_COMMANDS: ReadonlySet<string> = new Set(['install', 'uninstall', 'lock', 'run']);
/** Commands that take `--registry <dir>` — the session registry is injected when the flag is omitted. */
export const REGISTRY_COMMANDS: ReadonlySet<string> = new Set(['publish', 'search', 'registry']);

/**
 * Extracts a one-line description from a registered command's `usage`
 * string. The existing registrars use two shapes: a single line with the
 * description after a wide gap (`xo version      Print the CLI version`),
 * or a synopsis followed by a deeply indented description line. Returns
 * '' when neither shape matches — callers fall back to the synopsis.
 */
export function describeUsage(usage: string): string {
  const lines = usage.split('\n');
  const deep = lines.slice(1).find((l) => /^ {20,}\S/.test(l));
  if (deep) return deep.trim();
  const inline = /^\s*xo\s.*?\s{3,}(\S.*)$/.exec(lines[0] ?? '');
  return inline ? inline[1]!.trim() : '';
}

/** `xo compile <source>... [--json]` -> `<source>...`: the positional arguments up to the first flag or optional group. */
export function argHintFromUsage(usage: string, name: string): string | undefined {
  const first = (usage.split('\n')[0] ?? '').trim().replace(/\s{3,}\S.*$/, '');
  const m = new RegExp(`^xo\\s+${name}\\s*(.*)$`).exec(first);
  if (!m) return undefined;
  const positional: string[] = [];
  for (const token of m[1]!.split(/\s+/)) {
    if (token === '' ) continue;
    if (token.startsWith('[') || token.startsWith('--')) break;
    positional.push(token);
  }
  const hint = positional.join(' ').trim();
  return hint === '' ? undefined : hint;
}

/** Every `--flag` mentioned in a usage string, for flag Tab-completion. */
export function flagsFromUsage(usage: string): string[] {
  return [...new Set(usage.match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
}

export function buildCatalog(registry: CommandRegistry, sessionCommands: readonly CatalogEntry[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [...sessionCommands];
  const taken = new Set(entries.map((e) => e.name));
  for (const { commands } of registry.listBySubsystem().values()) {
    for (const command of commands) {
      if (taken.has(command.name)) continue;
      const synopsis = command.usage.split('\n')[0]!.trim();
      const args = argHintFromUsage(command.usage, command.name);
      entries.push({
        name: command.name,
        description: describeUsage(command.usage) || synopsis,
        usage: command.usage,
        ...(args !== undefined ? { args } : {}),
        completes: PATH_COMMANDS.has(command.name) ? 'path' : 'none',
        takesArgs: args !== undefined,
        source: 'command',
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Closest candidate to `name` by prefix or small edit distance, for "did you mean" hints. */
export function closestMatch(name: string, candidates: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  const prefix = candidates.find((c) => c.startsWith(lower) || lower.startsWith(c));
  if (prefix) return prefix;
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = editDistance(lower, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

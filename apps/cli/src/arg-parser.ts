/**
 * A small, dependency-free argument parser. Handles exactly what this
 * CLI's command set needs: a subcommand plus `--flag` / `--flag value`
 * options, including options repeated more than once (`--pubkey a=x
 * --pubkey b=y`, used by `xo verify`). Reach for a real CLI framework
 * (commander/yargs/clipanion) once real subcommands with nested options
 * arrive — see docs/adr/0002-language-and-runtime.md.
 */
export interface ParsedArgs {
  readonly command: string | undefined;
  /** Last occurrence wins per flag name — the original single-value behavior, unchanged. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Every string-valued occurrence of a flag, in order — e.g. repeated `--pubkey did=path` entries. Boolean (valueless) flags are not collected here. */
  readonly flagLists: Readonly<Record<string, readonly string[]>>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const hasLeadingCommand = argv.length > 0 && !argv[0]!.startsWith('--');
  const command = hasLeadingCommand ? argv[0] : undefined;
  const rest = hasLeadingCommand ? argv.slice(1) : argv;
  const flags: Record<string, string | boolean> = {};
  const flagLists: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        (flagLists[name] ??= []).push(next);
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, flags, flagLists, positionals };
}

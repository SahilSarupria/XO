/**
 * What every command function returns instead of printing directly or
 * calling `process.exit` itself. Keeping commands pure like this — data
 * in, `CommandResult` out — is what lets `index.ts` decide how to render
 * output (and lets tests assert on `exitCode`/`lines` without capturing
 * `process.stdout`).
 */
export interface CommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export function ok(lines: readonly string[]): CommandResult {
  return { exitCode: 0, lines };
}

export function fail(lines: readonly string[]): CommandResult {
  return { exitCode: 1, lines };
}

export function failWith(message: string): CommandResult {
  return fail([`error: ${message}`]);
}

/** Writes every line of a {@link CommandResult} to stdout and returns its exit code — the one place command registrars turn a `CommandResult` into what `CommandDefinition.run()` needs to return. */
export function printResult(result: CommandResult): number {
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.exitCode;
}

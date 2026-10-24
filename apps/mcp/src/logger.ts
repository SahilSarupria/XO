/**
 * Diagnostics go to STDERR only; stdout belongs to the MCP protocol. Callers pass event names and non-sensitive scalars; the
 * adapter never logs tool arguments, tool results, headers or the credential.
 */
export interface DiagLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export function stderrLogger(write: (line: string) => void = (l) => process.stderr.write(l)): DiagLogger {
  const emit = (level: string, event: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void => {
    write(`${JSON.stringify({ level, event, ...fields })}\n`);
  };
  return { info: (e, f) => emit('info', e, f), warn: (e, f) => emit('warn', e, f) };
}

export const silentLogger: DiagLogger = { info: () => undefined, warn: () => undefined };

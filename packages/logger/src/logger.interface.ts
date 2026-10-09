export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured logging port. Every log call takes a message plus optional
 * structured fields — never string-concatenate context into the message,
 * so logs stay machine-parseable in production (JSON transport).
 *
 * Implementations: {@link ConsoleLogger} (default, zero dependencies) and
 * {@link NoopLogger} (tests). A production deployment is expected to swap
 * in a transport-backed implementation (e.g. pino) behind this same
 * interface — see docs/adr/0004-observability.md.
 */
export interface Logger {
  readonly level: LogLevel;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Returns a new Logger that merges `fields` into every subsequent call. */
  child(fields: LogFields): Logger;
}

export const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

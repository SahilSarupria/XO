import type { Logger } from './logger.interface.js';

/** Discards everything. Used as the default logger for unit tests and libraries that must not force a logging framework on their host. */
export class NoopLogger implements Logger {
  public readonly level = 'fatal' as const;
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  child(): Logger {
    return this;
  }
}

export const noopLogger: Logger = new NoopLogger();

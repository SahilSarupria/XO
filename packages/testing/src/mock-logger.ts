import type { LogFields, Logger, LogLevel } from '@xo/logger';

export interface CapturedLogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * An in-memory {@link Logger} that captures every call for assertions
 * instead of writing anywhere. Preferred over `noopLogger` in tests that
 * need to assert *what* was logged (e.g. "a warning was emitted").
 */
export class MockLogger implements Logger {
  public readonly level: LogLevel = 'trace';
  public readonly records: CapturedLogRecord[] = [];
  private readonly bound: LogFields;

  constructor(bound: LogFields = {}) {
    this.bound = bound;
  }

  private capture(level: LogLevel, message: string, fields?: LogFields): void {
    this.records.push({ level, message, fields: { ...this.bound, ...fields } });
  }

  trace(message: string, fields?: LogFields): void {
    this.capture('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.capture('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.capture('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.capture('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.capture('error', message, fields);
  }
  fatal(message: string, fields?: LogFields): void {
    this.capture('fatal', message, fields);
  }

  child(fields: LogFields): Logger {
    const child = new MockLogger({ ...this.bound, ...fields });
    // Share the same backing array so assertions against the root logger see child-emitted records too.
    (child as { records: CapturedLogRecord[] }).records = this.records;
    return child;
  }
}

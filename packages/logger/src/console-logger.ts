import { LOG_LEVEL_WEIGHT, type LogFields, type Logger, type LogLevel } from './logger.interface.js';

export interface ConsoleLoggerOptions {
  readonly level?: LogLevel;
  readonly name?: string;
  /** Injectable sink, mainly so tests can capture output instead of writing to real stdout. */
  readonly write?: (line: string) => void;
  readonly clock?: () => Date;
}

/**
 * Structured JSON logger with no runtime dependencies — one line of JSON
 * per call, safe to pipe into any log collector. This is the default used
 * by every package and by the CLI. Swap in a transport-backed logger
 * (e.g. pino) behind the same {@link Logger} interface for production
 * environments that need sampling, redaction, or high-throughput async I/O.
 */
export class ConsoleLogger implements Logger {
  public readonly level: LogLevel;
  private readonly name: string | undefined;
  private readonly fields: LogFields;
  private readonly write: (line: string) => void;
  private readonly clock: () => Date;

  constructor(options: ConsoleLoggerOptions = {}, fields: LogFields = {}) {
    this.level = options.level ?? 'info';
    this.name = options.name;
    this.fields = fields;
    this.write = options.write ?? ((line) => process.stdout.write(line + '\n'));
    this.clock = options.clock ?? (() => new Date());
    this.options = options;
  }

  private readonly options: ConsoleLoggerOptions;

  private log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.level]) return;
    const record = {
      timestamp: this.clock().toISOString(),
      level,
      logger: this.name,
      message,
      ...this.fields,
      ...fields,
    };
    this.write(JSON.stringify(record));
  }

  trace(message: string, fields?: LogFields): void {
    this.log('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }
  fatal(message: string, fields?: LogFields): void {
    this.log('fatal', message, fields);
  }

  child(fields: LogFields): Logger {
    return new ConsoleLogger(this.options, { ...this.fields, ...fields });
  }
}

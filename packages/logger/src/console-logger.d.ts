import { type LogFields, type Logger, type LogLevel } from './logger.interface.js';
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
export declare class ConsoleLogger implements Logger {
    readonly level: LogLevel;
    private readonly name;
    private readonly fields;
    private readonly write;
    private readonly clock;
    constructor(options?: ConsoleLoggerOptions, fields?: LogFields);
    private readonly options;
    private log;
    trace(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    fatal(message: string, fields?: LogFields): void;
    child(fields: LogFields): Logger;
}
//# sourceMappingURL=console-logger.d.ts.map
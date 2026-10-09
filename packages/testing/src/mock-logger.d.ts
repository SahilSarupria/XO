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
export declare class MockLogger implements Logger {
    readonly level: LogLevel;
    readonly records: CapturedLogRecord[];
    private readonly bound;
    constructor(bound?: LogFields);
    private capture;
    trace(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    fatal(message: string, fields?: LogFields): void;
    child(fields: LogFields): Logger;
}
//# sourceMappingURL=mock-logger.d.ts.map
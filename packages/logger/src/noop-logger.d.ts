import type { Logger } from './logger.interface.js';
/** Discards everything. Used as the default logger for unit tests and libraries that must not force a logging framework on their host. */
export declare class NoopLogger implements Logger {
    readonly level: "fatal";
    trace(): void;
    debug(): void;
    info(): void;
    warn(): void;
    error(): void;
    fatal(): void;
    child(): Logger;
}
export declare const noopLogger: Logger;
//# sourceMappingURL=noop-logger.d.ts.map
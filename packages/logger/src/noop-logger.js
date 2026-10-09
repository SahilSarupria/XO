/** Discards everything. Used as the default logger for unit tests and libraries that must not force a logging framework on their host. */
export class NoopLogger {
    level = 'fatal';
    trace() { }
    debug() { }
    info() { }
    warn() { }
    error() { }
    fatal() { }
    child() {
        return this;
    }
}
export const noopLogger = new NoopLogger();
//# sourceMappingURL=noop-logger.js.map
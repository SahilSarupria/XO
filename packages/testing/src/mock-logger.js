/**
 * An in-memory {@link Logger} that captures every call for assertions
 * instead of writing anywhere. Preferred over `noopLogger` in tests that
 * need to assert *what* was logged (e.g. "a warning was emitted").
 */
export class MockLogger {
    level = 'trace';
    records = [];
    bound;
    constructor(bound = {}) {
        this.bound = bound;
    }
    capture(level, message, fields) {
        this.records.push({ level, message, fields: { ...this.bound, ...fields } });
    }
    trace(message, fields) {
        this.capture('trace', message, fields);
    }
    debug(message, fields) {
        this.capture('debug', message, fields);
    }
    info(message, fields) {
        this.capture('info', message, fields);
    }
    warn(message, fields) {
        this.capture('warn', message, fields);
    }
    error(message, fields) {
        this.capture('error', message, fields);
    }
    fatal(message, fields) {
        this.capture('fatal', message, fields);
    }
    child(fields) {
        const child = new MockLogger({ ...this.bound, ...fields });
        // Share the same backing array so assertions against the root logger see child-emitted records too.
        child.records = this.records;
        return child;
    }
}
//# sourceMappingURL=mock-logger.js.map
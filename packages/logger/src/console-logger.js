import { LOG_LEVEL_WEIGHT } from './logger.interface.js';
/**
 * Structured JSON logger with no runtime dependencies — one line of JSON
 * per call, safe to pipe into any log collector. This is the default used
 * by every package and by the CLI. Swap in a transport-backed logger
 * (e.g. pino) behind the same {@link Logger} interface for production
 * environments that need sampling, redaction, or high-throughput async I/O.
 */
export class ConsoleLogger {
    level;
    name;
    fields;
    write;
    clock;
    constructor(options = {}, fields = {}) {
        this.level = options.level ?? 'info';
        this.name = options.name;
        this.fields = fields;
        this.write = options.write ?? ((line) => process.stdout.write(line + '\n'));
        this.clock = options.clock ?? (() => new Date());
        this.options = options;
    }
    options;
    log(level, message, fields) {
        if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.level])
            return;
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
    trace(message, fields) {
        this.log('trace', message, fields);
    }
    debug(message, fields) {
        this.log('debug', message, fields);
    }
    info(message, fields) {
        this.log('info', message, fields);
    }
    warn(message, fields) {
        this.log('warn', message, fields);
    }
    error(message, fields) {
        this.log('error', message, fields);
    }
    fatal(message, fields) {
        this.log('fatal', message, fields);
    }
    child(fields) {
        return new ConsoleLogger(this.options, { ...this.fields, ...fields });
    }
}
//# sourceMappingURL=console-logger.js.map
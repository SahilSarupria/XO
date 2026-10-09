class ConsoleSpan {
    name;
    logger;
    attributes = {};
    status = 'unset';
    statusMessage;
    ended = false;
    startedAt = performance.now();
    constructor(name, logger, initialAttributes) {
        this.name = name;
        this.logger = logger;
        Object.assign(this.attributes, initialAttributes);
    }
    setAttribute(key, value) {
        this.attributes[key] = value;
    }
    recordException(error) {
        this.setStatus('error', error instanceof Error ? error.message : String(error));
        this.logger.error(`span exception: ${this.name}`, { error: error instanceof Error ? error.stack : String(error) });
    }
    setStatus(status, message) {
        this.status = status;
        this.statusMessage = message;
    }
    end() {
        if (this.ended)
            return;
        this.ended = true;
        const durationMs = performance.now() - this.startedAt;
        this.logger.debug(`span ended: ${this.name}`, {
            durationMs,
            status: this.status,
            statusMessage: this.statusMessage,
            ...this.attributes,
        });
    }
}
/** Emits spans as structured debug logs. Sufficient for local dev; a real deployment swaps in an OpenTelemetry SDK exporter behind the same {@link Tracer} interface. */
export class ConsoleTracer {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    startSpan(name, attributes) {
        return new ConsoleSpan(name, this.logger, attributes);
    }
    async withSpan(name, fn) {
        const span = this.startSpan(name);
        try {
            const result = await fn(span);
            span.setStatus('ok');
            return result;
        }
        catch (error) {
            span.recordException(error);
            throw error;
        }
        finally {
            span.end();
        }
    }
}
export class ConsoleMeter {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    createCounter(name, unit) {
        return {
            add: (value, attributes) => this.logger.info(`counter ${name}`, { value, unit, ...attributes }),
        };
    }
    createHistogram(name, unit) {
        return {
            record: (value, attributes) => this.logger.info(`histogram ${name}`, { value, unit, ...attributes }),
        };
    }
}
//# sourceMappingURL=console-exporter.js.map
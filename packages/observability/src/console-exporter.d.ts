import type { Logger } from '@xo/logger';
import type { Span, Tracer } from './tracer.interface.js';
import type { Counter, Histogram, Meter } from './meter.interface.js';
/** Emits spans as structured debug logs. Sufficient for local dev; a real deployment swaps in an OpenTelemetry SDK exporter behind the same {@link Tracer} interface. */
export declare class ConsoleTracer implements Tracer {
    private readonly logger;
    constructor(logger: Logger);
    startSpan(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): Span;
    withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T>;
}
export declare class ConsoleMeter implements Meter {
    private readonly logger;
    constructor(logger: Logger);
    createCounter(name: string, unit?: string): Counter;
    createHistogram(name: string, unit?: string): Histogram;
}
//# sourceMappingURL=console-exporter.d.ts.map
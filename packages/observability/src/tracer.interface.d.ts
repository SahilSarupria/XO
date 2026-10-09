export type SpanStatus = 'unset' | 'ok' | 'error';
export interface Span {
    setAttribute(key: string, value: string | number | boolean): void;
    recordException(error: unknown): void;
    setStatus(status: SpanStatus, message?: string): void;
    end(): void;
}
/**
 * Modeled on OpenTelemetry's Tracer/Span shape so a real OTel SDK can be
 * dropped in behind this interface without touching call sites (see
 * docs/adr/0004-observability.md). No OTel dependency is taken here —
 * this module only defines the port.
 */
export interface Tracer {
    startSpan(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): Span;
    /** Runs `fn` inside a span, ending it (and recording any thrown error) automatically. */
    withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T>;
}
//# sourceMappingURL=tracer.interface.d.ts.map
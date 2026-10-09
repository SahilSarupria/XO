import type { Meter, Span, Tracer } from '@xo/observability';
/**
 * Instruments everything Runtime Stage 1's spec calls out: mount time,
 * verification failures, execution (planning) latency, package counts,
 * and mounted component counts. A thin wrapper over `@xo/observability`'s
 * `Meter`/`Tracer` ports — defaults to the no-op implementations so
 * `PackageLoader`/`CapabilityNegotiator` never require a real
 * OTel-backed meter/tracer to run (tests construct them with no
 * instrumentation at all by simply not passing this).
 */
export declare class RuntimeInstrumentation {
    private readonly meter;
    private readonly tracer;
    private readonly mountDurationMs;
    private readonly verificationFailuresTotal;
    private readonly planningLatencyMs;
    private readonly mountedPackageCount;
    private readonly mountedComponentCount;
    private readonly retrievalLatencyMs;
    private readonly aiCallLatencyMs;
    private readonly promptTokensTotal;
    private readonly completionTokensTotal;
    private readonly estimatedCostTotal;
    private readonly safetyVerdictsTotal;
    private readonly budgetExceededTotal;
    private readonly executionOutcomesTotal;
    private readonly executionDurationMs;
    constructor(meter?: Meter, tracer?: Tracer);
    recordMount(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordVerificationFailure(attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordPlanningLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordCounts(packageCount: number, componentCount: number): void;
    withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T>;
    recordRetrievalLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordAiCallLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordTokenUsage(usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
    }, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordCost(amount: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordSafetyVerdict(verdict: string, attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordBudgetExceeded(attributes: Readonly<Record<string, string | number | boolean>>): void;
    recordExecutionOutcome(status: string, durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void;
}
//# sourceMappingURL=instrumentation.d.ts.map
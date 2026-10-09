import { noopMeter, noopTracer } from '@xo/observability';
/**
 * Instruments everything Runtime Stage 1's spec calls out: mount time,
 * verification failures, execution (planning) latency, package counts,
 * and mounted component counts. A thin wrapper over `@xo/observability`'s
 * `Meter`/`Tracer` ports — defaults to the no-op implementations so
 * `PackageLoader`/`CapabilityNegotiator` never require a real
 * OTel-backed meter/tracer to run (tests construct them with no
 * instrumentation at all by simply not passing this).
 */
export class RuntimeInstrumentation {
    meter;
    tracer;
    mountDurationMs;
    verificationFailuresTotal;
    planningLatencyMs;
    mountedPackageCount;
    mountedComponentCount;
    // Stage 2
    retrievalLatencyMs;
    aiCallLatencyMs;
    promptTokensTotal;
    completionTokensTotal;
    estimatedCostTotal;
    safetyVerdictsTotal;
    budgetExceededTotal;
    executionOutcomesTotal;
    executionDurationMs;
    constructor(meter = noopMeter, tracer = noopTracer) {
        this.meter = meter;
        this.tracer = tracer;
        this.mountDurationMs = this.meter.createHistogram('xo_runtime_mount_duration_ms', 'ms');
        this.verificationFailuresTotal = this.meter.createCounter('xo_runtime_verification_failures_total');
        this.planningLatencyMs = this.meter.createHistogram('xo_runtime_planning_latency_ms', 'ms');
        // Recorded as histograms rather than up-down counters: `Meter` (see
        // `@xo/observability`) only exposes `Counter` (monotonic) and
        // `Histogram`, no gauge/up-down-counter primitive, and a package
        // count that can both rise (mount) and fall (unmount) doesn't fit a
        // monotonic counter. A histogram of observed counts over time is the
        // closest fit available without extending that port.
        this.mountedPackageCount = this.meter.createHistogram('xo_runtime_mounted_package_count');
        this.mountedComponentCount = this.meter.createHistogram('xo_runtime_mounted_component_count');
        // Stage 2
        this.retrievalLatencyMs = this.meter.createHistogram('xo_runtime_retrieval_latency_ms', 'ms');
        this.aiCallLatencyMs = this.meter.createHistogram('xo_runtime_ai_call_latency_ms', 'ms');
        this.promptTokensTotal = this.meter.createCounter('xo_runtime_prompt_tokens_total');
        this.completionTokensTotal = this.meter.createCounter('xo_runtime_completion_tokens_total');
        this.estimatedCostTotal = this.meter.createCounter('xo_runtime_estimated_cost_total');
        this.safetyVerdictsTotal = this.meter.createCounter('xo_runtime_safety_verdicts_total');
        this.budgetExceededTotal = this.meter.createCounter('xo_runtime_budget_exceeded_total');
        this.executionOutcomesTotal = this.meter.createCounter('xo_runtime_execution_outcomes_total');
        this.executionDurationMs = this.meter.createHistogram('xo_runtime_execution_duration_ms', 'ms');
    }
    recordMount(durationMs, attributes) {
        this.mountDurationMs.record(durationMs, attributes);
    }
    recordVerificationFailure(attributes) {
        this.verificationFailuresTotal.add(1, attributes);
    }
    recordPlanningLatency(durationMs, attributes) {
        this.planningLatencyMs.record(durationMs, attributes);
    }
    recordCounts(packageCount, componentCount) {
        this.mountedPackageCount.record(packageCount);
        this.mountedComponentCount.record(componentCount);
    }
    withSpan(name, fn) {
        return this.tracer.withSpan(name, fn);
    }
    // --- Stage 2 -------------------------------------------------------
    recordRetrievalLatency(durationMs, attributes) {
        this.retrievalLatencyMs.record(durationMs, attributes);
    }
    recordAiCallLatency(durationMs, attributes) {
        this.aiCallLatencyMs.record(durationMs, attributes);
    }
    recordTokenUsage(usage, attributes) {
        this.promptTokensTotal.add(usage.promptTokens, attributes);
        this.completionTokensTotal.add(usage.completionTokens, attributes);
    }
    recordCost(amount, attributes) {
        this.estimatedCostTotal.add(amount, attributes);
    }
    recordSafetyVerdict(verdict, attributes) {
        this.safetyVerdictsTotal.add(1, { ...attributes, verdict });
    }
    recordBudgetExceeded(attributes) {
        this.budgetExceededTotal.add(1, attributes);
    }
    recordExecutionOutcome(status, durationMs, attributes) {
        this.executionOutcomesTotal.add(1, { ...attributes, status });
        this.executionDurationMs.record(durationMs, { ...attributes, status });
    }
}
//# sourceMappingURL=instrumentation.js.map
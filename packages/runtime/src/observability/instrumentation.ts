import type { Counter, Histogram, Meter, Span, Tracer } from '@xo/observability';
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
  private readonly mountDurationMs: Histogram;
  private readonly verificationFailuresTotal: Counter;
  private readonly planningLatencyMs: Histogram;
  private readonly mountedPackageCount: Histogram;
  private readonly mountedComponentCount: Histogram;
  // Stage 2
  private readonly retrievalLatencyMs: Histogram;
  private readonly aiCallLatencyMs: Histogram;
  private readonly promptTokensTotal: Counter;
  private readonly completionTokensTotal: Counter;
  private readonly estimatedCostTotal: Counter;
  private readonly safetyVerdictsTotal: Counter;
  private readonly budgetExceededTotal: Counter;
  private readonly executionOutcomesTotal: Counter;
  private readonly executionDurationMs: Histogram;

  constructor(
    private readonly meter: Meter = noopMeter,
    private readonly tracer: Tracer = noopTracer,
  ) {
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

  recordMount(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.mountDurationMs.record(durationMs, attributes);
  }

  recordVerificationFailure(attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.verificationFailuresTotal.add(1, attributes);
  }

  recordPlanningLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.planningLatencyMs.record(durationMs, attributes);
  }

  recordCounts(packageCount: number, componentCount: number): void {
    this.mountedPackageCount.record(packageCount);
    this.mountedComponentCount.record(componentCount);
  }

  withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T> {
    return this.tracer.withSpan(name, fn);
  }

  // --- Stage 2 -------------------------------------------------------

  recordRetrievalLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.retrievalLatencyMs.record(durationMs, attributes);
  }

  recordAiCallLatency(durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.aiCallLatencyMs.record(durationMs, attributes);
  }

  recordTokenUsage(usage: { readonly promptTokens: number; readonly completionTokens: number }, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.promptTokensTotal.add(usage.promptTokens, attributes);
    this.completionTokensTotal.add(usage.completionTokens, attributes);
  }

  recordCost(amount: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.estimatedCostTotal.add(amount, attributes);
  }

  recordSafetyVerdict(verdict: string, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.safetyVerdictsTotal.add(1, { ...attributes, verdict });
  }

  recordBudgetExceeded(attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.budgetExceededTotal.add(1, attributes);
  }

  recordExecutionOutcome(status: string, durationMs: number, attributes: Readonly<Record<string, string | number | boolean>>): void {
    this.executionOutcomesTotal.add(1, { ...attributes, status });
    this.executionDurationMs.record(durationMs, { ...attributes, status });
  }

  /**
   * R6. Execution-level tracing correlation — wraps `fn` in a span
   * tagged with `executionId` (and `attemptId`, when a strategy-dispatch
   * attempt is what's being traced), reusing the existing `withSpan`
   * primitive rather than introducing a new tracing mechanism. `Span`
   * identity itself remains purely an observability concern (see the R6
   * design's "important semantic separation" note) — it is never
   * consulted by retry/idempotency/replay decision logic, only tagged
   * with the ids those layers already own.
   */
  withExecutionSpan<T>(name: string, ids: { readonly executionId: string; readonly attemptId?: string }, fn: (span: Span) => Promise<T> | T): Promise<T> {
    return this.withSpan(name, (span) => {
      span.setAttribute('executionId', ids.executionId);
      if (ids.attemptId !== undefined) span.setAttribute('attemptId', ids.attemptId);
      return fn(span);
    });
  }
}

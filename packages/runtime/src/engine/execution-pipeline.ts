import type { ProviderRequest, ProviderResponse, ProviderStreamEvent } from '@xo/ai-core';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import { validateCapabilityInput } from '@xo/capability-contract';
import { CapabilityNegotiator } from '../capability/capability-negotiator.js';
import { ContextAssembler, type AssembledContext } from '../context/context-assembler.js';
import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';
import type { ExecutionPlan } from '../execution/execution-plan.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import { ExecutionStrategyRouter } from '../execution/execution-strategy-router.js';
import { HybridExecutionExecutor, type HybridProviderRequestBuilder } from '../execution/hybrid-execution-executor.js';
import { CapabilityExecutor } from '../ai/capability-executor.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import { deriveExecutionId } from './execution-id.js';
import type { ExecutionHookContext, ExecutionHooks } from '../hooks/execution-hooks.js';
import { runHook } from '../hooks/execution-hooks.js';
import type { ExecutionId } from '../ids.js';
import { KnowledgeRetriever } from '../retrieval/knowledge-retriever.js';
import { mergeKnowledgeGraphs } from '../retrieval/knowledge-graph-merge.js';
import { MemoryManager } from '../memory/working-memory.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { ResponseAssembler, type StructuredResponse } from '../response/response-assembler.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { SafetyPipeline } from '../safety/safety-pipeline.js';
import { allowAllPermissionGate, type PermissionGate } from '../permissions/permission-gate.interface.js';
import { buildExecutionReceipt, buildCapabilityAuthorityReceipt } from '../session/execution-receipt.js';
import type { RuntimeCapabilityExecutor } from '../capability-authority/runtime-capability-executor.js';
import { SessionManager } from '../session/session-manager.js';
import { withCancelled, withExecuting, withFailed, withPlan, withReceipt, withTimedOut, type ExecutionSession } from '../session/execution-session.js';
import type { RuntimeContext } from '../runtime-context.js';
import type { StreamingResponse } from '../streaming/streaming-response.js';
import { WorkflowExecutor, type WorkflowExecutorOptions } from '../workflow/workflow-executor.js';
import type { WorkflowResult } from '../workflow/workflow-receipt.js';
import { ExecutionRetryPolicy, sleepRaced, type ExecutionRetryOptions } from '../execution/execution-retry-policy.js';
import { buildSimulatedProviderResponse, checkHybridSimulationSafety, deterministicSimulationRefusal, humanInTheLoopSimulationRefusal, SimulatingCapabilityExecutor } from '../execution/simulation-gate.js';
import { deriveAttemptId } from './execution-attempt-id.js';

const DEFAULT_TOKEN_BUDGET = 8000;

export interface ExecutionPipelineOptions {
  readonly hooks?: ExecutionHooks;
  readonly instrumentation?: RuntimeInstrumentation;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly memoryManager?: MemoryManager;
  readonly budgetManager?: BudgetManager;
  readonly safetyPipeline?: SafetyPipeline;
  readonly permissionGate?: PermissionGate;
  readonly contextAssembler?: ContextAssembler;
  readonly promptAssembler?: PromptAssembler;
  readonly responseAssembler?: ResponseAssembler;
  /** Stage 3. Forwarded verbatim to the internal `WorkflowExecutor` this pipeline constructs — see `ExecutionPipeline`'s doc comment for how/when it's used. Absent means workflow execution uses every `WorkflowExecutor` default. */
  readonly workflow?: WorkflowExecutorOptions;
  /**
   * R3 closure: the confidence half of "confidence + authorization
   * gating". A planned capability whose `declaration.confidence.score`
   * is strictly below this floor is denied with
   * `RUNTIME_CONFIDENCE_BELOW_THRESHOLD` before any permission check,
   * retrieval, or execution happens — mirroring `permissionGate`'s own
   * port pattern (an explicit, independently testable gate the host
   * configures, not one this package hardcodes an opinion for). Absent
   * (the default) performs no confidence check at all, identical in
   * spirit to `allowAllPermissionGate`: every existing caller's behavior
   * is unchanged unless it opts in. Confidence and authorization remain
   * two independent gates — this option never affects `permissionGate`
   * and vice versa.
   *
   * M1.4: this is the ONLY place a host configures a confidence floor.
   * For a `deterministic_rule` capability, `runDeterministicRuleExecution`
   * forwards this same value verbatim to `capabilityAuthorityExecutor.execute`
   * (see that method's doc comment), so the floor is also enforced at
   * the actual execution boundary — not just here — without ever being
   * independently reconfigured at that lower layer.
   */
  readonly minConfidence?: number;
  /**
   * R1/R2 closure: the authoritative execution-strategy decision point.
   * When a planned capability's `declaration.execution.mode` is
   * `'deterministic_rule'`, this pipeline routes to
   * `capabilityAuthorityExecutor.execute` (validating
   * `request.structuredInput` against `execution.inputSchema` first, per
   * R2) instead of calling the AI Capability Layer — see
   * `runDeterministicRuleExecution`. A `'model'` mode, or an absent
   * `execution` field entirely (every `.xo` package compiled before R1),
   * is completely unaffected and continues through the AI-provider path
   * exactly as before. If a capability declares `mode: 'deterministic_rule'`
   * and this option is not configured, the request is denied with
   * `RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED` — a deterministic-rule
   * capability must never silently fall through to the AI model, which
   * would defeat the entire point of declaring a strategy at all.
   */
  readonly capabilityAuthorityExecutor?: RuntimeCapabilityExecutor;
  /**
   * R6. Governs retry of the strategy-dispatch step ONLY — see
   * `execution/execution-retry-policy.ts`'s doc comment for the full
   * contract, and its `isRetryable` for exactly which
   * strategy/error-code combinations are ever retried (currently:
   * `'model'`-strategy provider failures only — never
   * `'deterministic_rule'`, never `'hybrid'`, in this R6 pass). Absent
   * means `maxAttempts: 1`, identical to every pre-R6 caller.
   */
  readonly retry?: ExecutionRetryOptions;
}

/**
 * R5 closure: `'hybrid'`-mode capabilities — see `runHybridExecution`
 * and `execution/hybrid-execution-executor.ts`'s own doc comment for the
 * full semantics. Not part of `PrepareOutcome`: a hybrid capability is
 * fully executed (and its `ExecutionResult` returned) from inside
 * `prepare()` itself, the same way `runDeterministicRuleExecution`'s
 * result is — `prepare()` never returns `ok: true` for a hybrid
 * capability, exactly as it never does for a deterministic one.
 */

interface PreparedExecution {
  readonly session: ExecutionSession;
  readonly plan: ExecutionPlan;
  readonly selected: CapabilityDescriptor;
  readonly assembled: AssembledContext;
  readonly providerRequest: ProviderRequest;
  readonly effectiveInput: string;
  readonly degraded: boolean;
}

type PrepareOutcome = { readonly ok: true; readonly value: PreparedExecution } | { readonly ok: false; readonly result: ExecutionResult };

/**
 * Runs the full Stage 2 execution flow described in the brief:
 * Capability Negotiation -> Load Installed XO -> Retrieve Required
 * Components -> Knowledge Retrieval -> Context Assembly -> Prompt
 * Assembly -> AI Capability Layer -> Structured Response -> Execution
 * Receipt -> Execution Session. Provider selection and mounting are
 * *not* this class's job — it takes an already-injected
 * `CapabilityExecutor` (wrapping one `ModelProvider`, `@xo/ai-core`) and
 * a `getContext` function reading whatever `PackageRegistry` state Stage
 * 1's `Runtime`/`PackageLoader` currently has mounted; this class only
 * reads that state, never mounts or unmounts anything itself.
 *
 * `run()` (non-streaming) and `runStreaming()` share everything through
 * `prepare()` — Capability Negotiation through Prompt Assembly — and
 * only differ in how they call the AI Capability Layer and how they
 * assemble the final response from what came back.
 *
 * Cancellation note: `@xo/ai-core`'s `ProviderRequest` has no
 * `AbortSignal`/cancellation field at all, so an in-flight provider call
 * can't actually be aborted at the network level — `raceCancellation`
 * below still guarantees the *pipeline* stops waiting on it and returns
 * promptly, but the underlying HTTP request (if any) keeps running in
 * the background until it naturally resolves or errors; its result is
 * simply discarded. This is a real, stated limitation of integrating at
 * the `ModelProvider` layer, not an oversight.
 *
 * Stage 3: `run()` checks `request.workflowGraph` as its very first
 * step, before touching anything else — set, the request is delegated
 * entirely to an internal `WorkflowExecutor` (see `runWorkflowRequest`);
 * absent, execution falls through to every line below completely
 * unchanged from Stage 2. `WorkflowExecutor`'s `capability` node handler
 * calls back into this same `run()` method (with `workflowGraph` unset
 * on the synthetic per-node request) for its own AI-calling nodes — see
 * `workflow/workflow-node-handlers.ts`.
 */
export class ExecutionPipeline {
  private readonly negotiator = new CapabilityNegotiator();
  private readonly memoryManager: MemoryManager;
  private readonly budgetManager: BudgetManager;
  private readonly safetyPipeline: SafetyPipeline;
  private readonly permissionGate: PermissionGate;
  private readonly contextAssembler: ContextAssembler;
  private readonly promptAssembler: PromptAssembler;
  private readonly responseAssembler: ResponseAssembler;
  private readonly hooks: ExecutionHooks | undefined;
  private readonly instrumentation: RuntimeInstrumentation | undefined;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly workflowExecutor: WorkflowExecutor;
  private readonly minConfidence: number | undefined;
  private readonly capabilityAuthorityExecutor: RuntimeCapabilityExecutor | undefined;
  private readonly strategyRouter = new ExecutionStrategyRouter();
  /**
   * R5. Constructed from this same pipeline's own `capabilityExecutor`
   * and `capabilityAuthorityExecutor` — not a new, independently
   * configurable option — because a hybrid step's `'model'`/
   * `'deterministic_rule'` strategy must run through the exact same
   * executor instance (and therefore the exact same host-supplied
   * `ModelProvider`/registry/permission configuration) a non-hybrid
   * capability of that mode already runs through on this pipeline. No
   * new required wiring for any existing caller of `ExecutionPipeline`.
   */
  private readonly hybridExecutor: HybridExecutionExecutor;
  /** R6. Same construction as `hybridExecutor`, but injected with `SimulatingCapabilityExecutor` instead of the real `capabilityExecutor` — used only when `runHybridExecution` has already confirmed (via `checkHybridSimulationSafety`) every declared step is `'model'`. Never receives a `'deterministic_rule'` step to run. */
  private readonly simulatingHybridExecutor: HybridExecutionExecutor;
  private readonly retryPolicy: ExecutionRetryPolicy;

  constructor(
    private readonly getContext: () => RuntimeContext,
    private readonly retriever: KnowledgeRetriever,
    private readonly capabilityExecutor: CapabilityExecutor,
    private readonly sessionManager: SessionManager,
    private readonly model: string,
    options: ExecutionPipelineOptions = {},
  ) {
    this.memoryManager = options.memoryManager ?? new MemoryManager();
    this.budgetManager = options.budgetManager ?? new BudgetManager();
    this.safetyPipeline = options.safetyPipeline ?? new SafetyPipeline();
    this.permissionGate = options.permissionGate ?? allowAllPermissionGate;
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler();
    this.promptAssembler = options.promptAssembler ?? new PromptAssembler();
    this.responseAssembler = options.responseAssembler ?? new ResponseAssembler();
    this.hooks = options.hooks;
    this.instrumentation = options.instrumentation;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.minConfidence = options.minConfidence;
    this.capabilityAuthorityExecutor = options.capabilityAuthorityExecutor;
    this.hybridExecutor = new HybridExecutionExecutor({ capabilityExecutor: this.capabilityExecutor, capabilityAuthorityExecutor: this.capabilityAuthorityExecutor });
    this.simulatingHybridExecutor = new HybridExecutionExecutor({ capabilityExecutor: new SimulatingCapabilityExecutor(), capabilityAuthorityExecutor: this.capabilityAuthorityExecutor });
    this.retryPolicy = new ExecutionRetryPolicy(options.retry);
    this.workflowExecutor = new WorkflowExecutor((request, cancellation) => this.run(request, cancellation), {
      ...(this.instrumentation ? { instrumentation: this.instrumentation } : {}),
      logger: this.logger,
      now: this.now,
      ...options.workflow,
    });
  }

  async run(request: ExecutionRequest, cancellation: ExecutionCancellation = new ExecutionCancellation()): Promise<ExecutionResult> {
    if (request.workflowGraph) return this.runWorkflowRequest(request, request.workflowGraph, cancellation);

    const executionId = deriveExecutionId(request.requestId);
    const hookCtx: ExecutionHookContext = { executionId, request };
    const startedAt = this.now().getTime();

    const prepared = await this.prepare(request, cancellation, hookCtx, executionId, startedAt);
    if (!prepared.ok) return prepared.result;
    const { session: preparedSession, plan, selected, providerRequest, effectiveInput, degraded } = prepared.value;
    let session = preparedSession;

    // R6. `'model'`-strategy simulation: the provider call is skipped
    // entirely — never invoked, never even attempted — and replaced with
    // an explicit, non-fabricated placeholder (see
    // `execution/simulation-gate.ts`). No retry loop applies here:
    // nothing can fail. `'deterministic_rule'`/`'hybrid'` simulation
    // requests never reach this method at all — `prepare()` refuses them
    // earlier, before `run()` would have anything to dispatch.
    let providerResponse: ProviderResponse;
    let attempts = 1;
    if (request.simulate === true) {
      if (cancellation.isCancelled) return this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation);
      providerResponse = buildSimulatedProviderResponse(providerRequest);
    } else {
      const dispatch = await this.dispatchModelWithRetry(providerRequest, cancellation, hookCtx, session, executionId, startedAt);
      if (!dispatch.ok) return dispatch.result;
      providerResponse = dispatch.response;
      attempts = dispatch.attempts;
    }
    await this.runHook(this.hooks?.onAfterAiCall, [hookCtx, providerResponse], executionId);
    this.instrumentation?.recordCost(selected.declaration.estimatedCost.amount, { capability: selected.declaration.id, package: selected.packageName });

    const structuredResponse = this.responseAssembler.assemble({ providerResponse, capability: selected, degraded });
    this.recordTurns(session.sessionId, effectiveInput, structuredResponse.content);

    const receipt = buildExecutionReceipt({
      plan,
      registry: this.getContext().registry,
      response: structuredResponse,
      validationResults: { valid: true, issues: [] },
      executionDurationMs: this.now().getTime() - startedAt,
      environment: request.environment,
      now: this.now,
      executionId,
      attempts,
      simulated: request.simulate === true,
      recordedInputs: { input: effectiveInput },
    });
    await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);

    session = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded }));
    cancellation.dispose();
    this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded });
    return { executionId, session, response: structuredResponse, receipt };
  }

  /**
   * R6. Retry loop for exactly one thing: a `'model'`-strategy
   * `CapabilityExecutor.execute` call (the non-hybrid path — see
   * `execution/execution-retry-policy.ts`'s doc comment for why hybrid
   * and deterministic_rule are excluded). Everything upstream of this
   * call (negotiation, confidence, authorization, retrieval, prompt
   * assembly — all of `prepare()`) already ran exactly once and is never
   * re-run by a retry; only the dispatch attempt itself repeats.
   *
   * Cancellation/timeout are checked at three points, matching the R6
   * design's retry state machine exactly: before each dispatch, after a
   * failed dispatch (before classifying it), and after backoff (before
   * the next attempt) — a cancellation/timeout observed at any of these
   * points ends the loop immediately via `terminateCancelled`, and no
   * further attempt is ever started once that happens.
   */
  private async dispatchModelWithRetry(
    providerRequest: ProviderRequest,
    cancellation: ExecutionCancellation,
    hookCtx: ExecutionHookContext,
    session: ExecutionSession,
    executionId: ExecutionId,
    startedAt: number,
  ): Promise<{ readonly ok: true; readonly response: ProviderResponse; readonly attempts: number } | { readonly ok: false; readonly result: ExecutionResult }> {
    let attempt = 1;
    for (;;) {
      if (cancellation.isCancelled) return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };

      const attemptId = deriveAttemptId(executionId, attempt);
      const aiOutcome = await this.raceCancellation(this.capabilityExecutor.execute(providerRequest), cancellation);
      if (aiOutcome.cancelled) return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };
      if (aiOutcome.value.ok) return { ok: true, response: aiOutcome.value.value, attempts: attempt };

      const error = aiOutcome.value.error;
      const canRetry = attempt < this.retryPolicy.maxAttempts && this.retryPolicy.isRetryable('model', error);
      if (!canRetry) {
        const finalError =
          attempt > 1
            ? new RuntimeError(ErrorCode.RUNTIME_RETRY_EXHAUSTED, `Execution "${executionId}" failed after ${attempt} attempts (attempt "${attemptId}"): ${error.message}`, { cause: error, context: { attempts: attempt } })
            : error;
        return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, finalError) };
      }

      const delayMs = this.retryPolicy.backoffDelayMs(attempt);
      const backoffOutcome = await sleepRaced(delayMs, cancellation);
      if (backoffOutcome === 'cancelled') return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };
      attempt += 1;
    }
  }

  /**
   * Streaming variant of `run()`. Returns immediately with an
   * `events: AsyncIterable<ProviderStreamEvent>` the caller can consume
   * as they arrive, and a `result: Promise<ExecutionResult>` that
   * resolves once the stream ends with the same kind of `ExecutionResult`
   * `run()` returns — receipt, session, and all. Falls back to a single
   * non-streaming `complete()` call (emitted as one `text_delta` +
   * `done`) for a `ModelProvider` that doesn't implement
   * `completeStream` — see `CapabilityExecutor.stream`.
   *
   * Stage 3: streaming a workflow is explicitly out of scope —
   * `request.workflowGraph` isn't inspected here, so a workflow request
   * passed to `runStreaming` falls through to the ordinary Stage 2
   * single-capability streaming path using `capabilityId`/`query`
   * exactly as before (almost certainly not what the caller wanted, but
   * a well-defined, unsurprising fallback rather than a silent no-op). A
   * caller with a workflow should use `run()`.
   */
  runStreaming(request: ExecutionRequest, cancellation: ExecutionCancellation = new ExecutionCancellation()): StreamingResponse {
    const executionId = deriveExecutionId(request.requestId);
    let resolveResult!: (result: ExecutionResult) => void;
    const result = new Promise<ExecutionResult>((resolve) => {
      resolveResult = resolve;
    });
    const events = this.streamEvents(request, cancellation, executionId, resolveResult);
    return { executionId, events, result };
  }

  private async *streamEvents(
    request: ExecutionRequest,
    cancellation: ExecutionCancellation,
    executionId: ExecutionId,
    resolveResult: (result: ExecutionResult) => void,
  ): AsyncGenerator<ProviderStreamEvent, void, void> {
    const hookCtx: ExecutionHookContext = { executionId, request };
    const startedAt = this.now().getTime();

    const prepared = await this.prepare(request, cancellation, hookCtx, executionId, startedAt);
    if (!prepared.ok) {
      resolveResult(prepared.result);
      return;
    }
    const { session: preparedSession, plan, selected, providerRequest, effectiveInput, degraded } = prepared.value;
    let session = preparedSession;

    // R6. Simulation and retry are deliberately NOT implemented for the
    // streaming path in this pass — see the R6 delivery report's
    // "Deferred" section for the exact reasoning (a partially-streamed
    // response cannot be safely retried without re-emitting duplicate
    // events to whatever already consumed the stream, and a simulated
    // stream's placeholder-vs-real distinction needs its own design
    // this pass doesn't attempt). Refusing outright — never silently
    // performing a real call while claiming `simulate: true` — is the
    // fail-closed choice consistent with the rest of R6's simulation
    // contract.
    if (request.simulate === true) {
      const error = new RuntimeError(ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY, 'Simulation is not supported for streaming execution in this R6 pass — use the non-streaming execute() path to simulate a model-strategy capability.');
      resolveResult(this.terminate(hookCtx, session, executionId, startedAt, error));
      return;
    }

    let content = '';
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: ProviderResponse['finishReason'] = 'stop';

    try {
      for await (const event of this.capabilityExecutor.stream(providerRequest)) {
        if (cancellation.isCancelled) break;
        if (event.type === 'text_delta') content += event.delta;
        else if (event.type === 'done') {
          usage = event.usage;
          finishReason = event.finishReason;
        }
        yield event;
      }
    } catch (cause) {
      const error = new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `AI Capability Layer stream failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      resolveResult(this.terminate(hookCtx, session, executionId, startedAt, error));
      return;
    }

    if (cancellation.isCancelled) {
      resolveResult(this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation));
      return;
    }

    const providerResponse: ProviderResponse = { text: content, usage, modelUsed: providerRequest.model, finishReason };
    await this.runHook(this.hooks?.onAfterAiCall, [hookCtx, providerResponse], executionId);
    this.instrumentation?.recordCost(selected.declaration.estimatedCost.amount, { capability: selected.declaration.id, package: selected.packageName });

    const structuredResponse = this.responseAssembler.assemble({ providerResponse, capability: selected, degraded });
    this.recordTurns(session.sessionId, effectiveInput, structuredResponse.content);

    const receipt = buildExecutionReceipt({
      plan,
      registry: this.getContext().registry,
      response: structuredResponse,
      validationResults: { valid: true, issues: [] },
      executionDurationMs: this.now().getTime() - startedAt,
      environment: request.environment,
      now: this.now,
      executionId,
      attempts: 1,
      simulated: false,
      recordedInputs: { input: effectiveInput },
    });
    await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);

    session = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded }));
    cancellation.dispose();
    this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded });
    resolveResult({ executionId, session, response: structuredResponse, receipt });
  }

  /** Capability Negotiation through Prompt Assembly — everything both `run()` and `runStreaming()` do identically before diverging on how they call the AI Capability Layer. */
  private async prepare(request: ExecutionRequest, cancellation: ExecutionCancellation, hookCtx: ExecutionHookContext, executionId: ExecutionId, startedAt: number): Promise<PrepareOutcome> {
    await this.runHook(this.hooks?.onStart, [hookCtx], executionId);
    let session = this.sessionManager.create(request);

    if (request.input === undefined || request.input.length === 0) {
      return { ok: false, result: this.terminate(hookCtx, withFailed(session, this.now), executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, 'ExecutionRequest.input is required to execute (only optional for Stage 1 planning)')) };
    }

    // 1. Capability Negotiation (Stage 1, reused unmodified)
    const context = this.getContext();
    const plan = this.negotiator.plan(request, context);
    await this.runHook(this.hooks?.onPlanned, [hookCtx, plan], executionId);
    session = this.sessionManager.update(withPlan(session, plan, this.now));

    if (plan.status !== 'planned' || !plan.selected) {
      return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_PLAN_FAILED, `No compatible capability found for request "${request.requestId}" (${plan.status})`)) };
    }
    const selected = plan.selected.capability;

    // 1b. Confidence gate (R3) — independent of, and runs before, the
    // authorization gate below: a capability below the configured floor
    // never even reaches a permission check, since there is nothing to
    // authorize if it isn't trusted enough to run at all. A no-op when
    // `minConfidence` isn't configured (see `ExecutionPipelineOptions`'s
    // doc comment on why that's the deliberate default). M1.4: for a
    // `deterministic_rule` capability this same floor is enforced again,
    // against the same `this.minConfidence`, at the actual execution
    // boundary inside `runDeterministicRuleExecution` — this check here
    // is what protects every strategy (`model`/`deterministic_rule`/
    // `hybrid`) uniformly and as early as possible; it is not weakened
    // or replaced by the lower-layer check.
    if (this.minConfidence !== undefined && selected.declaration.confidence.score < this.minConfidence) {
      return {
        ok: false,
        result: this.terminate(
          hookCtx,
          session,
          executionId,
          startedAt,
          new RuntimeError(
            ErrorCode.RUNTIME_CONFIDENCE_BELOW_THRESHOLD,
            `Capability "${selected.declaration.id}" has confidence ${selected.declaration.confidence.score} (basis: ${selected.declaration.confidence.basis}), below the configured minimum of ${this.minConfidence}`,
          ),
        ),
      };
    }

    if (cancellation.isCancelled) return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };

    // 2. Load Installed XO
    const mounted = context.registry.get(selected.packageName, selected.packageVersion);
    if (!mounted) {
      return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_NOT_MOUNTED, `Selected package "${selected.packageName}@${selected.packageVersion}" is not mounted`)) };
    }
    session = this.sessionManager.update(withExecuting(session, this.now));


    // 2b. Permission gate (§19 integration seam) — runs before any
    // retrieval/prompt work, mirroring the "not mounted"/"plan failed"
    // checks above. A no-op with the default `allowAllPermissionGate`.
    // Every auxiliary capability in `request.auxiliaryCapabilityIds` (see
    // step 3 below) passes through this exact same gate before its data
    // is retrieved — there is no path through this pipeline that reaches
    // `retriever.retrieveForPackage` or `capabilityExecutor` without a
    // gate check first, primary or auxiliary alike.
    const permissionVerdict = await this.permissionGate.check(mounted, selected.declaration.id, request);
    if (!permissionVerdict.allowed) {
      return {
        ok: false,
        result: this.terminate(hookCtx, session, executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_PERMISSION_DENIED, permissionVerdict.reason ?? `Capability "${selected.declaration.id}" was denied a required permission`)),
      };
    }

    // 2c. Execution-strategy dispatch (R1's authoritative decision point,
    // closed; generalized in R4; widened to a third strategy in R5;
    // widened to a fourth in the Human-in-the-Loop Execution Class
    // Lowering milestone). `selected.declaration.execution.mode` — set by
    // the compiler's lowering pass (`@xo/compiler`'s
    // `capability-lowering.ts`) from the SAME resolved (contract,
    // binding) pair as everything else on this declaration — is resolved
    // here, and only here, via `ExecutionStrategyRouter` to decide HOW
    // this capability runs. This is the one and only place in this
    // pipeline that branches on execution strategy — there is no second,
    // independent guess. The router itself executes nothing: it only
    // names which of the four registered strategies
    // (`RuntimeCapabilityExecutor` for `'deterministic_rule'` AND
    // `'human_in_the_loop'` alike, the AI Capability Layer below for
    // `'model'`/absent, `HybridExecutionExecutor` for R5's `'hybrid'`)
    // this capability's declared mode maps to, or fails closed with
    // `RUNTIME_UNSUPPORTED_EXECUTION_MODE` for a mode this runtime has no
    // registered strategy for (see that class's doc comment) — never
    // silently defaulting an unrecognized mode to the model path.
    const strategyResolution = this.strategyRouter.resolve(selected.declaration.execution?.mode);
    if (!strategyResolution.ok) {
      return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, strategyResolution.error) };
    }
    if (strategyResolution.value === 'deterministic_rule' || strategyResolution.value === 'human_in_the_loop') {
      // R6 (+ this milestone's extension to `'human_in_the_loop'`).
      // Simulation of either strategy always refuses, before
      // `runDeterministicRuleExecution` — and therefore the bound
      // handler — is ever reached. See `execution/simulation-gate.ts`'s
      // top doc comment for why this is permanent-until-a-future-
      // contract-change rather than a best-effort guess. Both strategies
      // are routed through the SAME `runDeterministicRuleExecution`
      // method below unchanged: it already reads `execution.mode` only
      // to have been dispatched here (never re-branches on it itself),
      // calls the same generic, implementationClass-agnostic
      // `capabilityAuthorityExecutor.execute`, and a `human_in_the_loop`
      // binding's registered handler is wrapped identically to a
      // `deterministic_rule` one's (`capability-binding-registration.ts`)
      // — there is no separate "HITL executor" to build.
      if (request.simulate === true) {
        const refusal = strategyResolution.value === 'deterministic_rule' ? deterministicSimulationRefusal(selected.declaration.id) : humanInTheLoopSimulationRefusal(selected.declaration.id);
        return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, refusal) };
      }
      return { ok: false, result: await this.runDeterministicRuleExecution(request, plan, selected, session, hookCtx, executionId, startedAt) };
    }
    // 'hybrid' (R5) falls through to steps 3-6 below UNCHANGED — a
    // hybrid capability may contain a 'model' step, so it needs the
    // exact same retrieval/safety/budget/context/prompt-assembly a
    // non-hybrid 'model' capability already gets; only the very end of
    // `prepare()` (after step 6 builds `providerRequest`) diverges,
    // handing off to `runHybridExecution` instead of returning `ok: true`
    // for `run()`/`runStreaming()` to call `capabilityExecutor` directly.
    const isHybrid = strategyResolution.value === 'hybrid';

    // 3. Retrieve Required Components (+ auxiliary capabilities' components — "multiple installed XOs")
    const primaryRetrieval = await this.retriever.retrieveForPackage(mounted, selected.declaration.requiredComponents);
    if (!primaryRetrieval.ok) return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, primaryRetrieval.error) };
    let slices = [...primaryRetrieval.value];

    for (const auxiliaryId of request.auxiliaryCapabilityIds ?? []) {
      const auxiliaryDescriptor = context.capabilities.find(auxiliaryId)[0];
      if (!auxiliaryDescriptor) continue;
      const auxiliaryMounted = context.registry.get(auxiliaryDescriptor.packageName, auxiliaryDescriptor.packageVersion);
      if (!auxiliaryMounted) continue;

      // §6 (Stage 2): an auxiliary capability's component data is
      // retrieved and merged into context alongside the primary
      // capability's own — it never gets its own inference call
      // (`capabilityExecutor` is only ever invoked once, below, for
      // `selected`), but retrieval itself reads a package's data, which
      // is exactly what permissions like `data.read`/`filesystem.read`
      // gate. Without this check, `auxiliaryCapabilityIds` would be a
      // live bypass: a capability whose own permission check failed
      // (or was never reached) could still have its data pulled in as
      // an auxiliary of some *other*, permitted request. Same gate, same
      // fail-closed treatment as the primary capability above — an
      // auxiliary denial fails the whole request rather than silently
      // dropping that one source, so a caller never gets a response
      // assembled from a partially-authorized context without knowing it.
      const auxiliaryVerdict = await this.permissionGate.check(auxiliaryMounted, auxiliaryDescriptor.declaration.id, request);
      if (!auxiliaryVerdict.allowed) {
        return {
          ok: false,
          result: this.terminate(hookCtx, session, executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_PERMISSION_DENIED, auxiliaryVerdict.reason ?? `Auxiliary capability "${auxiliaryDescriptor.declaration.id}" was denied a required permission`)),
        };
      }

      const auxiliaryRetrieval = await this.retriever.retrieveForPackage(auxiliaryMounted, auxiliaryDescriptor.declaration.requiredComponents);
      if (!auxiliaryRetrieval.ok) return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, auxiliaryRetrieval.error) };
      slices = [...slices, ...auxiliaryRetrieval.value];
    }
    await this.runHook(this.hooks?.onRetrieved, [hookCtx, slices], executionId);

    if (cancellation.isCancelled) return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };

    // 4. Knowledge Retrieval: merge every knowledge_graph slice across however many packages contributed one
    const mergedGraph = mergeKnowledgeGraphs(slices);

    // Safety check runs on the raw input against every retrieved safety_rules
    // slice before any budget trimming — trimming must never remove a
    // safety_rules slice out from under this check (BudgetManager.fit never
    // drops safety_rules regardless of priority order).
    const safety = this.safetyPipeline.check(request.input, slices);
    this.instrumentation?.recordSafetyVerdict(safety.verdict, { capability: selected.declaration.id });
    if (safety.verdict === 'block') {
      return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, new RuntimeError(ErrorCode.RUNTIME_SAFETY_BLOCKED, safety.reason ?? `Request blocked by "${mounted.name}"'s safety rules`)) };
    }
    const effectiveInput = safety.verdict === 'redact' && safety.redactedInput !== undefined ? safety.redactedInput : request.input;
    let degraded = safety.verdict === 'redact';

    const tokenBudget = request.environment.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const fit = this.budgetManager.fit(slices, tokenBudget);
    if (fit.degraded) {
      degraded = true;
      this.instrumentation?.recordBudgetExceeded({ capability: selected.declaration.id, droppedCount: fit.dropped.length });
      this.logger.warn('budget exceeded, dropping lowest-priority slices', { executionId, dropped: fit.dropped.map((s) => s.componentKind).join(',') });
    }

    // 5. Context Assembly
    const assembled = this.contextAssembler.assemble({
      capability: selected,
      slices: fit.kept,
      ...(mergedGraph.sourceCount > 0 ? { mergedKnowledgeGraph: mergedGraph } : {}),
    });
    await this.runHook(this.hooks?.onContextAssembled, [hookCtx, assembled], executionId);

    if (cancellation.isCancelled) return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };

    // 6. Prompt Assembly
    const priorTurns = this.memoryManager.get(session.sessionId);
    const providerRequest: ProviderRequest = this.promptAssembler.assemble({
      context: assembled,
      model: this.model,
      input: effectiveInput,
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      priorTurns,
    });
    await this.runHook(this.hooks?.onBeforeAiCall, [hookCtx, providerRequest], executionId);

    if (isHybrid) {
      const buildProviderRequest = (overrideInput: string): ProviderRequest =>
        this.promptAssembler.assemble({
          context: assembled,
          model: this.model,
          input: overrideInput,
          ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
          priorTurns,
        });
      return { ok: false, result: await this.runHybridExecution(request, plan, selected, session, hookCtx, executionId, startedAt, effectiveInput, degraded, buildProviderRequest, cancellation) };
    }

    return { ok: true, value: { session, plan, selected, assembled, providerRequest, effectiveInput, degraded } };
  }

  /**
   * R1/R2 closure: executes a `mode: 'deterministic_rule'` capability —
   * and, as of the Human-in-the-Loop Execution Class Lowering milestone,
   * a `mode: 'human_in_the_loop'` one identically — through the Runtime
   * capability-authority layer instead of the AI Capability Layer. Both
   * modes share this one method unchanged because
   * `capabilityAuthorityExecutor` (`RuntimeCapabilityExecutor`) and the
   * registration path that feeds it (`capability-binding-registration.ts`)
   * are themselves already `implementationClass`-agnostic: neither
   * branches on whether the underlying binding is `'deterministic_rule'`
   * or `'human_in_the_loop'`, so this method doesn't need to either.
   * Reached only from `prepare()`'s dispatch point, only after the plan,
   * confidence gate, mount check, and manifest permission gate have all
   * already passed — this method adds two more checks specific to this
   * path (input validation, then capability-authority resolution + its
   * own independent permission check inside
   * `RuntimeCapabilityExecutor.execute`) and never repeats or bypasses
   * the checks `prepare()` already ran.
   *
   * Fails closed, deterministically, on exactly two conditions this
   * method itself is responsible for:
   *   1. No `capabilityAuthorityExecutor` configured at all —
   *      `RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED`. A declared
   *      `deterministic_rule` capability must never silently execute as
   *      if it were `'model'` mode just because the host forgot to wire
   *      the executor.
   *   2. `execution.inputSchema` present and `request.structuredInput`
   *      fails `validateCapabilityInput` (R2) —
   *      `RUNTIME_CAPABILITY_INPUT_INVALID`. Checked BEFORE calling
   *      `capabilityAuthorityExecutor.execute`, so a malformed input
   *      never reaches the resolved binding's evaluator, exactly as
   *      `validateCapabilityInput`'s own doc comment requires.
   *
   * M1.4: also forwards `selected.declaration.confidence.score` and this
   * pipeline's own `minConfidence` into the `capabilityAuthorityExecutor.execute`
   * call (see `RuntimeCapabilityExecutionRequest`'s doc comment in
   * `runtime-capability-executor.ts`). For a call that reached this
   * method normally, `prepare()`'s own confidence gate (step 1b, above)
   * already guaranteed `score >= minConfidence`, so this second check is
   * a no-op here — it exists so the *same* executor, called directly by
   * some other host code path that skips `prepare()` entirely, is held
   * to the identical floor rather than none. Forwarding the pipeline's
   * own `this.minConfidence` verbatim (never a second, independently
   * configured value) is what keeps this a single source of truth.
   */
  private async runDeterministicRuleExecution(
    request: ExecutionRequest,
    plan: ExecutionPlan,
    selected: CapabilityDescriptor,
    session: ExecutionSession,
    hookCtx: ExecutionHookContext,
    executionId: ExecutionId,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const execution = selected.declaration.execution;
    /* istanbul ignore next -- guarded by the `mode === 'deterministic_rule'` check at the only call site */
    if (!execution) throw new Error('runDeterministicRuleExecution called without an execution declaration');

    if (!this.capabilityAuthorityExecutor) {
      return this.terminate(
        hookCtx,
        session,
        executionId,
        startedAt,
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED,
          `Capability "${selected.declaration.id}" declares execution.mode "${execution.mode}" but this pipeline has no capabilityAuthorityExecutor configured — refusing to fall back to the AI Capability Layer for a capability that explicitly declared a capability-authority strategy`,
        ),
      );
    }

    const structuredInput = request.structuredInput ?? {};
    if (execution.inputSchema) {
      const validation = validateCapabilityInput(execution.inputSchema, structuredInput);
      if (!validation.valid) {
        const detail = validation.issues.map((issue) => `${issue.property}: ${issue.message}`).join('; ');
        return this.terminate(
          hookCtx,
          session,
          executionId,
          startedAt,
          new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, `Input for capability "${selected.declaration.id}" failed its declared input schema: ${detail}`),
        );
      }
    }

    const capabilityId = execution.contractId ?? selected.declaration.id;
    const authorityResult = await this.capabilityAuthorityExecutor.execute({
      capabilityId,
      input: structuredInput,
      confidenceScore: selected.declaration.confidence.score,
      ...(this.minConfidence !== undefined ? { minConfidence: this.minConfidence } : {}),
    });
    if (!authorityResult.ok) {
      return this.terminate(hookCtx, session, executionId, startedAt, authorityResult.error);
    }

    const structuredResponse: StructuredResponse = Object.freeze({
      content: JSON.stringify(authorityResult.value.output),
      stopReason: 'end_turn',
      usage: { promptTokens: 0, completionTokens: 0 },
      capabilityId: selected.declaration.id,
      packageName: selected.packageName,
      packageVersion: selected.packageVersion,
      degraded: false,
    });

    // R6-replay depends on `ExecutionReceipt.contractId` being set to
    // recognize a deterministic_rule original (see `execution/replay.ts`'s
    // contract) — which only `buildCapabilityAuthorityReceipt` sets.
    // `authorityResult.value` carries `contractId`/`bindingId`/
    // `sourceXoirNodeIds` only when the executed declaration was
    // registered via `registerResolvedCapabilityBinding` (real discovered-
    // and-bound capabilities); a hand-authored `RuntimeCapabilityDeclaration`
    // with no such provenance falls back to `buildExecutionReceipt`, same
    // as before this fix, rather than fabricating the three required
    // fields `buildCapabilityAuthorityReceipt` would otherwise need.
    const hasCapabilityAuthorityProvenance =
      authorityResult.value.contractId !== undefined && authorityResult.value.bindingId !== undefined && authorityResult.value.sourceXoirNodeIds !== undefined;

    const receipt = hasCapabilityAuthorityProvenance
      ? buildCapabilityAuthorityReceipt({
          requestId: plan.requestId,
          planId: plan.planId,
          capabilityId: selected.declaration.id,
          contractId: authorityResult.value.contractId!,
          bindingId: authorityResult.value.bindingId!,
          sourceXoirNodeIds: authorityResult.value.sourceXoirNodeIds!,
          executionDurationMs: this.now().getTime() - startedAt,
          now: this.now,
          executionId,
          attempts: 1,
          simulated: false,
          recordedInputs: structuredInput,
          recordedOutput: authorityResult.value.output,
          ...(authorityResult.value.graphHash !== undefined ? { graphHash: authorityResult.value.graphHash } : {}),
          ...(authorityResult.value.contractContentHash !== undefined ? { contractContentHash: authorityResult.value.contractContentHash } : {}),
        })
      : buildExecutionReceipt({
          plan,
          registry: this.getContext().registry,
          response: structuredResponse,
          validationResults: { valid: true, issues: [] },
          executionDurationMs: this.now().getTime() - startedAt,
          environment: request.environment,
          now: this.now,
          executionId,
          attempts: 1,
          simulated: false,
          recordedInputs: structuredInput,
          recordedOutput: authorityResult.value.output,
        });
    await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);

    const finalSession = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded: false }));
    this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded: false });
    return { executionId, session: finalSession, response: structuredResponse, receipt };
  }

  /**
   * R5 closure: executes a `mode: 'hybrid'` capability's ordered
   * `hybridSteps` via `HybridExecutionExecutor`, then folds the result
   * into the same single `ExecutionResult` shape every other strategy on
   * this pipeline produces. Reached only from `prepare()`'s dispatch
   * point, only after everything `'model'`-mode capabilities already get
   * — plan, R3 confidence gate, mount check, manifest permission gate,
   * retrieval, safety, budget, context assembly, prompt assembly — has
   * already run; this method adds no new pre-execution gate of its own
   * beyond what `HybridExecutionExecutor` itself enforces per step (R2
   * validation, R1 capability-authority configuration, R3's own
   * `RuntimeCapabilityExecutor`-level permission check).
   *
   * Builds the final `StructuredResponse` from whichever strategy the
   * *last* declared step used: a trailing `'model'` step's
   * `ProviderResponse` goes through the exact same `ResponseAssembler`
   * every non-hybrid `'model'` capability's response does (so token
   * usage, cost accounting, and response shape are identical); a
   * trailing `'deterministic_rule'` step's output is stringified the
   * exact same way `runDeterministicRuleExecution` already stringifies a
   * non-hybrid deterministic capability's output. Either way, exactly
   * one `ExecutionReceipt` is built (via `buildExecutionReceipt`, the
   * same builder the `'model'` path uses) with one additional, purely
   * additive field — `hybridSteps` — naming every step that ran.
   *
   * Fails the whole invocation, with no partial receipt, on the first
   * step `HybridExecutionExecutor.execute` reports as failed — R5's
   * "no successful final receipt after a failed hybrid step" requirement.
   */
  private async runHybridExecution(
    request: ExecutionRequest,
    plan: ExecutionPlan,
    selected: CapabilityDescriptor,
    session: ExecutionSession,
    hookCtx: ExecutionHookContext,
    executionId: ExecutionId,
    startedAt: number,
    effectiveInput: string,
    degraded: boolean,
    buildProviderRequest: HybridProviderRequestBuilder,
    cancellation: ExecutionCancellation,
  ): Promise<ExecutionResult> {
    const execution = selected.declaration.execution;
    /* istanbul ignore next -- guarded by the `strategyResolution.value === 'hybrid'` check at the only call site */
    if (!execution) throw new Error('runHybridExecution called without an execution declaration');

    const steps = execution.hybridSteps ?? [];
    if (steps.length === 0) {
      return this.terminate(
        hookCtx,
        session,
        executionId,
        startedAt,
        new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Capability "${selected.declaration.id}" declares execution.mode "hybrid" but declares no hybridSteps`),
      );
    }

    // R6. Hybrid retry is deliberately NOT implemented in this pass (see
    // `execution/execution-retry-policy.ts`'s `isRetryable` doc comment
    // for the exact dependency being deferred) — `hybridExecutor.execute`
    // below always runs exactly once, regardless of any configured
    // `ExecutionRetryOptions.maxAttempts`.
    //
    // Simulation, by contrast, IS decidable safely here: unlike retry
    // (which needs to know which steps *actually ran* before a runtime
    // failure — information R5's `HybridExecutionExecutor` doesn't
    // expose), simulation only needs each step's *declared* strategy,
    // which is fully known up front from `steps` itself. So a hybrid
    // capability whose every declared step is `'model'` can be simulated
    // safely; the instant one step is `'deterministic_rule'`, the whole
    // invocation refuses before any step — including an earlier
    // otherwise-safe `'model'` step — ever runs.
    let hybridExecutor = this.hybridExecutor;
    if (request.simulate === true) {
      const safety = checkHybridSimulationSafety(steps);
      if (!safety.ok) return this.terminate(hookCtx, session, executionId, startedAt, safety.error);
      hybridExecutor = this.simulatingHybridExecutor;
    }

    const hybridOutcome = await hybridExecutor.execute(
      steps,
      { requestInput: effectiveInput, structuredInput: request.structuredInput ?? {}, capabilityId: selected.declaration.id },
      buildProviderRequest,
      // The exact same `raceCancellation` this pipeline already uses around
      // its single AI-provider call in `run()` (see that method's own
      // `raceCancellation(this.capabilityExecutor.execute(...), cancellation)`
      // call) — bound to this one request's `cancellation`, so every step
      // `HybridExecutionExecutor` awaits observes the same whole-request
      // cancellation signal, never a new one.
      (promise) => this.raceCancellation(promise, cancellation),
    );
    if (hybridOutcome.cancelled) {
      return this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation);
    }
    if (!hybridOutcome.result.ok) {
      return this.terminate(hookCtx, session, executionId, startedAt, hybridOutcome.result.error);
    }
    const { finalOutput, finalModelResponse, steps: stepOutcomes } = hybridOutcome.result.value;

    let structuredResponse: StructuredResponse;
    if (finalModelResponse) {
      await this.runHook(this.hooks?.onAfterAiCall, [hookCtx, finalModelResponse], executionId);
      this.instrumentation?.recordCost(selected.declaration.estimatedCost.amount, { capability: selected.declaration.id, package: selected.packageName });
      structuredResponse = this.responseAssembler.assemble({ providerResponse: finalModelResponse, capability: selected, degraded });
    } else {
      structuredResponse = Object.freeze({
        content: JSON.stringify(finalOutput),
        stopReason: 'end_turn',
        usage: { promptTokens: 0, completionTokens: 0 },
        capabilityId: selected.declaration.id,
        packageName: selected.packageName,
        packageVersion: selected.packageVersion,
        degraded,
      });
    }
    this.recordTurns(session.sessionId, effectiveInput, structuredResponse.content);

    const receipt = {
      ...buildExecutionReceipt({
        plan,
        registry: this.getContext().registry,
        response: structuredResponse,
        validationResults: { valid: true, issues: [] },
        executionDurationMs: this.now().getTime() - startedAt,
        environment: request.environment,
        now: this.now,
        executionId,
        attempts: 1,
        simulated: request.simulate === true,
        recordedInputs: { input: effectiveInput },
      }),
      hybridSteps: stepOutcomes.map((outcome) => ({ stepId: outcome.stepId, strategy: outcome.strategy })),
    };
    await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);

    const finalSession = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded }));
    cancellation.dispose();
    this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded });
    return { executionId, session: finalSession, response: structuredResponse, receipt };
  }

  private recordTurns(sessionId: ExecutionSession['sessionId'], input: string, responseContent: string): void {
    this.memoryManager.append(sessionId, { role: 'user', content: input, recordedAt: this.now().toISOString() });
    this.memoryManager.append(sessionId, { role: 'assistant', content: responseContent, recordedAt: this.now().toISOString() });
  }

  private async runHook<Args extends unknown[]>(hook: ((...args: Args) => void | Promise<void>) | undefined, args: Args, executionId: ExecutionId): Promise<void> {
    await runHook(hook, args, (error) => this.logger.warn('execution hook threw', { executionId, error: error instanceof Error ? error.message : String(error) }));
  }

  /**
   * Stage 3's entire integration point with `run()`: delegates to
   * `WorkflowExecutor.run`, then folds the `WorkflowResult` into an
   * `ExecutionResult` so `ExecutionEngine.execute`'s return type doesn't
   * need to change based on whether a request was a workflow — a Stage
   * 2 caller reading `result.response.content` still gets something
   * sensible (a JSON summary), while `result.workflowResult` carries the
   * full per-node detail for a caller that wants it.
   */
  private async runWorkflowRequest(request: ExecutionRequest, graph: import('../workflow/workflow-graph.js').WorkflowGraph, cancellation: ExecutionCancellation): Promise<ExecutionResult> {
    const executionId = deriveExecutionId(request.requestId);
    let session = this.sessionManager.create(request);
    session = this.sessionManager.update(withExecuting(session, this.now));

    const workflowResult = await this.workflowExecutor.run(graph, request.environment, cancellation);

    if (workflowResult.error || !workflowResult.receipt) {
      const finalSession = this.sessionManager.update(withFailed(session, this.now));
      return { executionId, session: finalSession, workflowResult, ...(workflowResult.error ? { error: workflowResult.error } : {}) };
    }

    const summaryContent = JSON.stringify(workflowResult.instance.state.outputs);
    const structuredResponse = this.responseAssembler.assemble({
      providerResponse: { text: summaryContent, usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: this.model, finishReason: 'stop' },
      capability: { declaration: { id: graph.graphId, name: graph.graphId, description: 'workflow', providerCompatibility: [], requiredComponents: [], estimatedCost: workflowResult.receipt.resourceUsage.estimatedCost > 0 ? { currency: 'USD', amount: workflowResult.receipt.resourceUsage.estimatedCost } : { currency: 'USD', amount: 0 }, estimatedLatencyMs: workflowResult.receipt.durationMs, confidence: { score: 1, basis: 'self_reported' } }, packageName: graph.graphId, packageVersion: graph.version },
      degraded: workflowResult.receipt.skippedNodeCount > 0,
    });

    // Not every workflow contains a `capability` node (a pure
    // decision/delay graph might not), so there isn't always a Stage 2
    // `ExecutionReceipt` to attach via `withReceipt` — the workflow's own
    // `WorkflowReceipt` (in `workflowResult.receipt`) is always present
    // and always the authoritative record regardless. When at least one
    // `capability` node did run, its receipt is folded into
    // `session.receipts` too, purely so a caller only inspecting
    // `session.receipts` (the Stage 2 convention) still sees something.
    const firstNodeReceipt = workflowResult.receipt.nodeReceipts[0]?.receipt;
    const finalSession = this.sessionManager.update(
      firstNodeReceipt
        ? withReceipt(session, firstNodeReceipt, this.now, { degraded: workflowResult.receipt.skippedNodeCount > 0 })
        : { ...session, status: 'completed' as const, degraded: workflowResult.receipt.skippedNodeCount > 0, updatedAt: this.now().toISOString() },
    );
    return { executionId, session: finalSession, response: structuredResponse, workflowResult };
  }

  private terminate(hookCtx: ExecutionHookContext, session: ExecutionSession, executionId: ExecutionId, startedAt: number, error: RuntimeError): ExecutionResult {
    const finalSession = session.status === 'planned' || session.status === 'pending' || session.status === 'executing' ? withFailed(session, this.now) : session;
    void this.runHook(this.hooks?.onError, [hookCtx, error], executionId);
    this.instrumentation?.recordExecutionOutcome(finalSession.status, this.now().getTime() - startedAt, { errorCode: error.code });
    return { executionId, session: this.sessionManager.update(finalSession), error };
  }

  private terminateCancelled(hookCtx: ExecutionHookContext, session: ExecutionSession, executionId: ExecutionId, startedAt: number, cancellation: ExecutionCancellation): ExecutionResult {
    const isTimeout = cancellation.reason === 'timeout';
    const finalSession = isTimeout ? withTimedOut(session, this.now) : withCancelled(session, this.now);
    const error = new RuntimeError(isTimeout ? ErrorCode.RUNTIME_EXECUTION_TIMEOUT : ErrorCode.RUNTIME_EXECUTION_CANCELLED, isTimeout ? 'Execution timed out' : 'Execution was cancelled');
    void this.runHook(this.hooks?.onCancelled, [hookCtx, cancellation.reason], executionId);
    this.instrumentation?.recordExecutionOutcome(finalSession.status, this.now().getTime() - startedAt, {});
    return { executionId, session: this.sessionManager.update(finalSession), error };
  }

  /** Resolves as soon as either `promise` settles or `cancellation` fires. Note (see class doc comment): this stops the *pipeline* from waiting, not the underlying provider call, which `@xo/ai-core`'s `ProviderRequest` has no mechanism to actually abort. */
  private raceCancellation<T>(promise: Promise<T>, cancellation: ExecutionCancellation): Promise<{ readonly cancelled: false; readonly value: T } | { readonly cancelled: true }> {
    if (cancellation.isCancelled) return Promise.resolve({ cancelled: true });
    return new Promise((resolve, reject) => {
      const onAbort = (): void => resolve({ cancelled: true });
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          cancellation.signal.removeEventListener('abort', onAbort);
          resolve({ cancelled: false, value });
        },
        (cause: unknown) => {
          cancellation.signal.removeEventListener('abort', onAbort);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        },
      );
    });
  }
}

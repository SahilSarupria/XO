import type { ModelProvider } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { CapabilityExecutor } from '../ai/capability-executor.js';
import { CapabilityExecutor as CapabilityExecutorImpl } from '../ai/capability-executor.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import type { ExecutionHooks } from '../hooks/execution-hooks.js';
import { composeMiddleware, type ExecutionMiddleware } from '../hooks/execution-middleware.js';
import type { ExecutionId, SessionId } from '../ids.js';
import { MemoryManager } from '../memory/working-memory.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { KnowledgeRetriever } from '../retrieval/knowledge-retriever.js';
import { ResponseAssembler } from '../response/response-assembler.js';
import type { RuntimeContext } from '../runtime-context.js';
import { SafetyPipeline } from '../safety/safety-pipeline.js';
import { withFailed, type ExecutionSession } from '../session/execution-session.js';
import { SessionManager } from '../session/session-manager.js';
import type { StreamingResponse } from '../streaming/streaming-response.js';
import { ExecutionPipeline } from './execution-pipeline.js';
import { deriveExecutionId } from './execution-id.js';
import type { PermissionGate } from '../permissions/permission-gate.interface.js';
import type { PackageInstaller } from '@xo/package-sdk';
import type { RuntimeCapabilityExecutor } from '../capability-authority/runtime-capability-executor.js';
import type { ExecutionRetryOptions } from '../execution/execution-retry-policy.js';

export interface ExecutionEngineOptions {
  readonly middleware?: readonly ExecutionMiddleware[];
  readonly hooks?: ExecutionHooks;
  readonly instrumentation?: RuntimeInstrumentation;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Default per-execution timeout, applied unless a caller passes its own `ExecutionCancellation` to `executeWithCancellation`/`executeStreaming`. Absent means no default timeout. */
  readonly defaultTimeoutMs?: number;
  readonly memoryManager?: MemoryManager;
  readonly budgetManager?: BudgetManager;
  readonly safetyPipeline?: SafetyPipeline;
  readonly permissionGate?: PermissionGate;
  readonly contextAssembler?: ContextAssembler;
  readonly promptAssembler?: PromptAssembler;
  readonly responseAssembler?: ResponseAssembler;
  /**
   * A concrete model identifier for every `ProviderRequest` this engine
   * builds — `@xo/ai-core`'s `ModelProvider.complete`/`completeStream`
   * require one (`ProviderRequest.model`) and, since `ExecutionEngine`
   * talks to a single injected `ModelProvider` directly rather than
   * `AiCapabilityLayer`'s routing (see `CapabilityExecutor`'s doc
   * comment for why), nothing else picks one automatically. Defaults to
   * the injected provider's own first advertised model
   * (`provider.describeCapabilities().models[0]`) if omitted.
   */
  readonly model?: string;
  /** R3 closure. Forwarded verbatim to `ExecutionPipeline` — see that class's `ExecutionPipelineOptions.minConfidence` doc comment. Absent means no confidence gate, matching every prior `ExecutionEngine` caller's behavior. */
  readonly minConfidence?: number;
  /** R1/R2 closure. Forwarded verbatim to `ExecutionPipeline` — see that class's `ExecutionPipelineOptions.capabilityAuthorityExecutor` doc comment. Absent means a `deterministic_rule` capability is denied rather than silently executed as if it were `'model'` mode. */
  readonly capabilityAuthorityExecutor?: RuntimeCapabilityExecutor;
  /** R6. Forwarded verbatim to `ExecutionPipeline` — see `execution/execution-retry-policy.ts`'s `ExecutionRetryOptions` doc comment. Absent means `maxAttempts: 1` — no retry, every pre-R6 caller's behavior unchanged. */
  readonly retry?: ExecutionRetryOptions;
}

/**
 * Runtime Stage 2's top-level entry point: "the runtime should now be
 * capable of executing an installed Experience Object." Wires
 * `ExecutionPipeline` behind {@link ExecutionMiddleware} composition and
 * a live cancellation registry (`cancel(executionId)`), and is the one
 * class most callers construct directly.
 *
 * Takes a `ModelProvider` (`@xo/ai-core`) and a `PackageInstaller`
 * (`@xo/package-sdk`) as its only two external dependencies — provider
 * selection/configuration and package mounting both stay entirely their
 * owners' concerns; `ExecutionEngine` never constructs or selects a
 * provider (it does default `options.model` from whichever provider it's
 * given, since `@xo/ai-core`'s `ProviderRequest` has no implicit default
 * the way the provisional stand-in package this replaced did), and never
 * mounts anything.
 */
export class ExecutionEngine {
  private readonly sessionManager: SessionManager;
  private readonly pipeline: ExecutionPipeline;
  private readonly runWithMiddleware: (request: ExecutionRequest, cancellation: ExecutionCancellation) => Promise<ExecutionResult>;
  private readonly activeCancellations = new Map<string, ExecutionCancellation>();
  private readonly defaultTimeoutMs: number | undefined;

  constructor(getContext: () => RuntimeContext, installer: PackageInstaller, provider: ModelProvider, options: ExecutionEngineOptions = {}) {
    this.sessionManager = new SessionManager(options.now);
    const retriever = new KnowledgeRetriever(installer, {
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.instrumentation !== undefined ? { instrumentation: options.instrumentation } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const capabilityExecutor: CapabilityExecutor = new CapabilityExecutorImpl(provider, {
      ...(options.instrumentation !== undefined ? { instrumentation: options.instrumentation } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const model = options.model ?? provider.describeCapabilities().models[0];
    if (model === undefined) {
      throw new Error('ExecutionEngine: no model specified and the provided ModelProvider advertises no models — pass options.model explicitly');
    }

    this.pipeline = new ExecutionPipeline(getContext, retriever, capabilityExecutor, this.sessionManager, model, {
      ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options.instrumentation !== undefined ? { instrumentation: options.instrumentation } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.memoryManager !== undefined ? { memoryManager: options.memoryManager } : {}),
      ...(options.budgetManager !== undefined ? { budgetManager: options.budgetManager } : {}),
      ...(options.safetyPipeline !== undefined ? { safetyPipeline: options.safetyPipeline } : {}),
      ...(options.permissionGate !== undefined ? { permissionGate: options.permissionGate } : {}),
      ...(options.contextAssembler !== undefined ? { contextAssembler: options.contextAssembler } : {}),
      ...(options.promptAssembler !== undefined ? { promptAssembler: options.promptAssembler } : {}),
      ...(options.responseAssembler !== undefined ? { responseAssembler: options.responseAssembler } : {}),
      ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
      ...(options.capabilityAuthorityExecutor !== undefined ? { capabilityAuthorityExecutor: options.capabilityAuthorityExecutor } : {}),
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    });
    this.defaultTimeoutMs = options.defaultTimeoutMs;

    // The middleware chain's "core" wraps `pipeline.run` with cancellation
    // registration/cleanup, so `cancel(executionId)` works regardless of
    // whether middleware short-circuits before ever reaching the pipeline.
    //
    // R6 in-flight dedup (execution-bookkeeping idempotency, per the R6
    // design's §4.1 — deliberately NOT side-effect idempotency, see that
    // section): `deriveExecutionId` is pure and deterministic, so two
    // calls sharing the same `RequestId` derive the same `ExecutionId`.
    // If one is already registered in `activeCancellations`, this engine
    // instance refuses the second call outright rather than starting a
    // second concurrent attempt at the same logical execution — this
    // says nothing about a call on a *different* `ExecutionEngine`
    // instance/process, and nothing about a request whose prior attempt
    // already finished (only genuinely concurrent in-flight collisions
    // are caught here; there is no persistence layer to consult for
    // "was this already run to completion").
    const core = async (request: ExecutionRequest, cancellation: ExecutionCancellation): Promise<ExecutionResult> => {
      const executionId = deriveExecutionId(request.requestId);
      if (this.activeCancellations.has(executionId)) {
        return this.buildAlreadyInFlightResult(request, executionId);
      }
      this.activeCancellations.set(executionId, cancellation);
      try {
        return await this.pipeline.run(request, cancellation);
      } finally {
        cancellation.dispose();
        this.activeCancellations.delete(executionId);
      }
    };
    const composeForCancellation = (cancellation: ExecutionCancellation) => composeMiddleware(options.middleware ?? [], (request) => core(request, cancellation));
    this.runWithMiddleware = (request, cancellation) => composeForCancellation(cancellation)(request);
  }

  /** Executes `request` end to end, applying any configured middleware. Equivalent to `executeWithCancellation(request, new ExecutionCancellation(defaultTimeoutMs))`. */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.runWithMiddleware(request, new ExecutionCancellation(this.defaultTimeoutMs));
  }

  /** Like `execute`, but with an explicit `ExecutionCancellation` — for a caller-specific timeout, or to cancel via a handle obtained before calling. */
  async executeWithCancellation(request: ExecutionRequest, cancellation: ExecutionCancellation): Promise<ExecutionResult> {
    return this.runWithMiddleware(request, cancellation);
  }

  /**
   * Streaming variant. Bypasses middleware (middleware's `next` returns a
   * single `ExecutionResult`, not a stream — composing it with a
   * streaming call is a later stage's concern if ever needed) but still
   * registers for `cancel(executionId)`.
   *
   * R6: shares the exact same in-flight dedup guard as `execute`/
   * `executeWithCancellation` (see `core`'s doc comment above) — a
   * `RequestId` already streaming on this engine instance refuses a
   * second concurrent call with an immediately-empty event stream and a
   * `result` that resolves to the same `RUNTIME_EXECUTION_ALREADY_IN_FLIGHT`
   * shape the non-streaming path returns.
   */
  executeStreaming(request: ExecutionRequest, cancellation: ExecutionCancellation = new ExecutionCancellation(this.defaultTimeoutMs)): StreamingResponse {
    const executionId = deriveExecutionId(request.requestId);
    if (this.activeCancellations.has(executionId)) {
      return { executionId, events: (async function* () {})(), result: Promise.resolve(this.buildAlreadyInFlightResult(request, executionId)) };
    }
    const streaming = this.pipeline.runStreaming(request, cancellation);
    this.activeCancellations.set(streaming.executionId, cancellation);
    void streaming.result.finally(() => {
      cancellation.dispose();
      this.activeCancellations.delete(streaming.executionId);
    });
    return streaming;
  }

  /** Cancels an in-flight execution by its deterministic `ExecutionId` (derive one from a `RequestId` with `deriveExecutionId` if needed). Returns `false` — not an error — if nothing with that id is currently running. */
  cancel(executionId: ExecutionId, reason?: string): boolean {
    const cancellation = this.activeCancellations.get(executionId);
    if (!cancellation) return false;
    cancellation.cancel(reason);
    return true;
  }

  get activeExecutionCount(): number {
    return this.activeCancellations.size;
  }

  session(sessionId: SessionId): ExecutionSession | undefined {
    return this.sessionManager.get(sessionId);
  }

  sessions(): readonly ExecutionSession[] {
    return this.sessionManager.all();
  }

  /**
   * R6. Builds the `ExecutionResult` returned when `request.requestId`
   * (== `executionId`, via `deriveExecutionId`) already has an in-flight
   * attempt on this engine instance. Creates and immediately fails a
   * session (via the same `SessionManager` `ExecutionPipeline` itself
   * uses) purely so `ExecutionResult.session` — a required field — has
   * something real to report; this session is never confused with the
   * original in-flight execution's own session (different `sessionId`,
   * since `createSession` mints a fresh one per call).
   */
  private buildAlreadyInFlightResult(request: ExecutionRequest, executionId: ExecutionId): ExecutionResult {
    const session = this.sessionManager.update(withFailed(this.sessionManager.create(request)));
    const error = new RuntimeError(
      ErrorCode.RUNTIME_EXECUTION_ALREADY_IN_FLIGHT,
      `Execution "${executionId}" (requestId "${request.requestId}") is already in flight on this engine instance — refusing to start a second concurrent attempt at the same logical execution. This is execution-bookkeeping idempotency only: it says nothing about whether a prior, now-completed attempt with this requestId already ran.`,
    );
    return { executionId, session, error };
  }
}

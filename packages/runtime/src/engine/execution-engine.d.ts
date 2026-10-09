import type { ModelProvider } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { BudgetManager } from '../budget/budget-manager.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import type { ExecutionHooks } from '../hooks/execution-hooks.js';
import { type ExecutionMiddleware } from '../hooks/execution-middleware.js';
import type { ExecutionId, SessionId } from '../ids.js';
import { MemoryManager } from '../memory/working-memory.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { ResponseAssembler } from '../response/response-assembler.js';
import type { RuntimeContext } from '../runtime-context.js';
import { SafetyPipeline } from '../safety/safety-pipeline.js';
import type { ExecutionSession } from '../session/execution-session.js';
import type { StreamingResponse } from '../streaming/streaming-response.js';
import type { PermissionGate } from '../permissions/permission-gate.interface.js';
import type { PackageInstaller } from '@xo/package-sdk';
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
export declare class ExecutionEngine {
    private readonly sessionManager;
    private readonly pipeline;
    private readonly runWithMiddleware;
    private readonly activeCancellations;
    private readonly defaultTimeoutMs;
    constructor(getContext: () => RuntimeContext, installer: PackageInstaller, provider: ModelProvider, options?: ExecutionEngineOptions);
    /** Executes `request` end to end, applying any configured middleware. Equivalent to `executeWithCancellation(request, new ExecutionCancellation(defaultTimeoutMs))`. */
    execute(request: ExecutionRequest): Promise<ExecutionResult>;
    /** Like `execute`, but with an explicit `ExecutionCancellation` — for a caller-specific timeout, or to cancel via a handle obtained before calling. */
    executeWithCancellation(request: ExecutionRequest, cancellation: ExecutionCancellation): Promise<ExecutionResult>;
    /**
     * Streaming variant. Bypasses middleware (middleware's `next` returns a
     * single `ExecutionResult`, not a stream — composing it with a
     * streaming call is a later stage's concern if ever needed) but still
     * registers for `cancel(executionId)`.
     */
    executeStreaming(request: ExecutionRequest, cancellation?: ExecutionCancellation): StreamingResponse;
    /** Cancels an in-flight execution by its deterministic `ExecutionId` (derive one from a `RequestId` with `deriveExecutionId` if needed). Returns `false` — not an error — if nothing with that id is currently running. */
    cancel(executionId: ExecutionId, reason?: string): boolean;
    get activeExecutionCount(): number;
    session(sessionId: SessionId): ExecutionSession | undefined;
    sessions(): readonly ExecutionSession[];
}
//# sourceMappingURL=execution-engine.d.ts.map
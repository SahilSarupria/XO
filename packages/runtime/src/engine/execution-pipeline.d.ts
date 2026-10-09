import type { Logger } from '@xo/logger';
import { ContextAssembler } from '../context/context-assembler.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import { CapabilityExecutor } from '../ai/capability-executor.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ExecutionHooks } from '../hooks/execution-hooks.js';
import { KnowledgeRetriever } from '../retrieval/knowledge-retriever.js';
import { MemoryManager } from '../memory/working-memory.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { ResponseAssembler } from '../response/response-assembler.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { SafetyPipeline } from '../safety/safety-pipeline.js';
import { type PermissionGate } from '../permissions/permission-gate.interface.js';
import { SessionManager } from '../session/session-manager.js';
import type { RuntimeContext } from '../runtime-context.js';
import type { StreamingResponse } from '../streaming/streaming-response.js';
import { type WorkflowExecutorOptions } from '../workflow/workflow-executor.js';
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
}
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
export declare class ExecutionPipeline {
    private readonly getContext;
    private readonly retriever;
    private readonly capabilityExecutor;
    private readonly sessionManager;
    private readonly model;
    private readonly negotiator;
    private readonly memoryManager;
    private readonly budgetManager;
    private readonly safetyPipeline;
    private readonly permissionGate;
    private readonly contextAssembler;
    private readonly promptAssembler;
    private readonly responseAssembler;
    private readonly hooks;
    private readonly instrumentation;
    private readonly logger;
    private readonly now;
    private readonly workflowExecutor;
    constructor(getContext: () => RuntimeContext, retriever: KnowledgeRetriever, capabilityExecutor: CapabilityExecutor, sessionManager: SessionManager, model: string, options?: ExecutionPipelineOptions);
    run(request: ExecutionRequest, cancellation?: ExecutionCancellation): Promise<ExecutionResult>;
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
    runStreaming(request: ExecutionRequest, cancellation?: ExecutionCancellation): StreamingResponse;
    private streamEvents;
    /** Capability Negotiation through Prompt Assembly — everything both `run()` and `runStreaming()` do identically before diverging on how they call the AI Capability Layer. */
    private prepare;
    private recordTurns;
    private runHook;
    /**
     * Stage 3's entire integration point with `run()`: delegates to
     * `WorkflowExecutor.run`, then folds the `WorkflowResult` into an
     * `ExecutionResult` so `ExecutionEngine.execute`'s return type doesn't
     * need to change based on whether a request was a workflow — a Stage
     * 2 caller reading `result.response.content` still gets something
     * sensible (a JSON summary), while `result.workflowResult` carries the
     * full per-node detail for a caller that wants it.
     */
    private runWorkflowRequest;
    private terminate;
    private terminateCancelled;
    /** Resolves as soon as either `promise` settles or `cancellation` fires. Note (see class doc comment): this stops the *pipeline* from waiting, not the underlying provider call, which `@xo/ai-core`'s `ProviderRequest` has no mechanism to actually abort. */
    private raceCancellation;
}
//# sourceMappingURL=execution-pipeline.d.ts.map
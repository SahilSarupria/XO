import { CapabilityExecutor as CapabilityExecutorImpl } from '../ai/capability-executor.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import { composeMiddleware } from '../hooks/execution-middleware.js';
import { KnowledgeRetriever } from '../retrieval/knowledge-retriever.js';
import { SessionManager } from '../session/session-manager.js';
import { ExecutionPipeline } from './execution-pipeline.js';
import { deriveExecutionId } from './execution-id.js';
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
    sessionManager;
    pipeline;
    runWithMiddleware;
    activeCancellations = new Map();
    defaultTimeoutMs;
    constructor(getContext, installer, provider, options = {}) {
        this.sessionManager = new SessionManager(options.now);
        const retriever = new KnowledgeRetriever(installer, {
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
            ...(options.instrumentation !== undefined ? { instrumentation: options.instrumentation } : {}),
            ...(options.now !== undefined ? { now: options.now } : {}),
        });
        const capabilityExecutor = new CapabilityExecutorImpl(provider, {
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
        });
        this.defaultTimeoutMs = options.defaultTimeoutMs;
        // The middleware chain's "core" wraps `pipeline.run` with cancellation
        // registration/cleanup, so `cancel(executionId)` works regardless of
        // whether middleware short-circuits before ever reaching the pipeline.
        const core = async (request, cancellation) => {
            const executionId = deriveExecutionId(request.requestId);
            this.activeCancellations.set(executionId, cancellation);
            try {
                return await this.pipeline.run(request, cancellation);
            }
            finally {
                cancellation.dispose();
                this.activeCancellations.delete(executionId);
            }
        };
        const composeForCancellation = (cancellation) => composeMiddleware(options.middleware ?? [], (request) => core(request, cancellation));
        this.runWithMiddleware = (request, cancellation) => composeForCancellation(cancellation)(request);
    }
    /** Executes `request` end to end, applying any configured middleware. Equivalent to `executeWithCancellation(request, new ExecutionCancellation(defaultTimeoutMs))`. */
    async execute(request) {
        return this.runWithMiddleware(request, new ExecutionCancellation(this.defaultTimeoutMs));
    }
    /** Like `execute`, but with an explicit `ExecutionCancellation` — for a caller-specific timeout, or to cancel via a handle obtained before calling. */
    async executeWithCancellation(request, cancellation) {
        return this.runWithMiddleware(request, cancellation);
    }
    /**
     * Streaming variant. Bypasses middleware (middleware's `next` returns a
     * single `ExecutionResult`, not a stream — composing it with a
     * streaming call is a later stage's concern if ever needed) but still
     * registers for `cancel(executionId)`.
     */
    executeStreaming(request, cancellation = new ExecutionCancellation(this.defaultTimeoutMs)) {
        const streaming = this.pipeline.runStreaming(request, cancellation);
        this.activeCancellations.set(streaming.executionId, cancellation);
        void streaming.result.finally(() => {
            cancellation.dispose();
            this.activeCancellations.delete(streaming.executionId);
        });
        return streaming;
    }
    /** Cancels an in-flight execution by its deterministic `ExecutionId` (derive one from a `RequestId` with `deriveExecutionId` if needed). Returns `false` — not an error — if nothing with that id is currently running. */
    cancel(executionId, reason) {
        const cancellation = this.activeCancellations.get(executionId);
        if (!cancellation)
            return false;
        cancellation.cancel(reason);
        return true;
    }
    get activeExecutionCount() {
        return this.activeCancellations.size;
    }
    session(sessionId) {
        return this.sessionManager.get(sessionId);
    }
    sessions() {
        return this.sessionManager.all();
    }
}
//# sourceMappingURL=execution-engine.js.map
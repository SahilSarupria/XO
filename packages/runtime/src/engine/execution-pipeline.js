import { ErrorCode, RuntimeError } from '@xo/errors';
import { noopLogger } from '@xo/logger';
import { CapabilityNegotiator } from '../capability/capability-negotiator.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import { deriveExecutionId } from './execution-id.js';
import { runHook } from '../hooks/execution-hooks.js';
import { mergeKnowledgeGraphs } from '../retrieval/knowledge-graph-merge.js';
import { MemoryManager } from '../memory/working-memory.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { ResponseAssembler } from '../response/response-assembler.js';
import { SafetyPipeline } from '../safety/safety-pipeline.js';
import { allowAllPermissionGate } from '../permissions/permission-gate.interface.js';
import { buildExecutionReceipt } from '../session/execution-receipt.js';
import { withCancelled, withExecuting, withFailed, withPlan, withReceipt, withTimedOut } from '../session/execution-session.js';
import { WorkflowExecutor } from '../workflow/workflow-executor.js';
const DEFAULT_TOKEN_BUDGET = 8000;
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
    getContext;
    retriever;
    capabilityExecutor;
    sessionManager;
    model;
    negotiator = new CapabilityNegotiator();
    memoryManager;
    budgetManager;
    safetyPipeline;
    permissionGate;
    contextAssembler;
    promptAssembler;
    responseAssembler;
    hooks;
    instrumentation;
    logger;
    now;
    workflowExecutor;
    constructor(getContext, retriever, capabilityExecutor, sessionManager, model, options = {}) {
        this.getContext = getContext;
        this.retriever = retriever;
        this.capabilityExecutor = capabilityExecutor;
        this.sessionManager = sessionManager;
        this.model = model;
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
        this.workflowExecutor = new WorkflowExecutor((request, cancellation) => this.run(request, cancellation), {
            ...(this.instrumentation ? { instrumentation: this.instrumentation } : {}),
            logger: this.logger,
            now: this.now,
            ...options.workflow,
        });
    }
    async run(request, cancellation = new ExecutionCancellation()) {
        if (request.workflowGraph)
            return this.runWorkflowRequest(request, request.workflowGraph, cancellation);
        const executionId = deriveExecutionId(request.requestId);
        const hookCtx = { executionId, request };
        const startedAt = this.now().getTime();
        const prepared = await this.prepare(request, cancellation, hookCtx, executionId, startedAt);
        if (!prepared.ok)
            return prepared.result;
        const { session: preparedSession, plan, selected, providerRequest, effectiveInput, degraded } = prepared.value;
        let session = preparedSession;
        const aiOutcome = await this.raceCancellation(this.capabilityExecutor.execute(providerRequest), cancellation);
        if (aiOutcome.cancelled)
            return this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation);
        if (!aiOutcome.value.ok)
            return this.terminate(hookCtx, session, executionId, startedAt, aiOutcome.value.error);
        const providerResponse = aiOutcome.value.value;
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
        });
        await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);
        session = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded }));
        cancellation.dispose();
        this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded });
        return { executionId, session, response: structuredResponse, receipt };
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
    runStreaming(request, cancellation = new ExecutionCancellation()) {
        const executionId = deriveExecutionId(request.requestId);
        let resolveResult;
        const result = new Promise((resolve) => {
            resolveResult = resolve;
        });
        const events = this.streamEvents(request, cancellation, executionId, resolveResult);
        return { executionId, events, result };
    }
    async *streamEvents(request, cancellation, executionId, resolveResult) {
        const hookCtx = { executionId, request };
        const startedAt = this.now().getTime();
        const prepared = await this.prepare(request, cancellation, hookCtx, executionId, startedAt);
        if (!prepared.ok) {
            resolveResult(prepared.result);
            return;
        }
        const { session: preparedSession, plan, selected, providerRequest, effectiveInput, degraded } = prepared.value;
        let session = preparedSession;
        let content = '';
        let usage = { inputTokens: 0, outputTokens: 0 };
        let finishReason = 'stop';
        try {
            for await (const event of this.capabilityExecutor.stream(providerRequest)) {
                if (cancellation.isCancelled)
                    break;
                if (event.type === 'text_delta')
                    content += event.delta;
                else if (event.type === 'done') {
                    usage = event.usage;
                    finishReason = event.finishReason;
                }
                yield event;
            }
        }
        catch (cause) {
            const error = new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `AI Capability Layer stream failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
            resolveResult(this.terminate(hookCtx, session, executionId, startedAt, error));
            return;
        }
        if (cancellation.isCancelled) {
            resolveResult(this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation));
            return;
        }
        const providerResponse = { text: content, usage, modelUsed: providerRequest.model, finishReason };
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
        });
        await this.runHook(this.hooks?.onReceipt, [hookCtx, receipt], executionId);
        session = this.sessionManager.update(withReceipt(session, receipt, this.now, { degraded }));
        cancellation.dispose();
        this.instrumentation?.recordExecutionOutcome('completed', this.now().getTime() - startedAt, { capability: selected.declaration.id, degraded });
        resolveResult({ executionId, session, response: structuredResponse, receipt });
    }
    /** Capability Negotiation through Prompt Assembly — everything both `run()` and `runStreaming()` do identically before diverging on how they call the AI Capability Layer. */
    async prepare(request, cancellation, hookCtx, executionId, startedAt) {
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
        if (cancellation.isCancelled)
            return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };
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
        // 3. Retrieve Required Components (+ auxiliary capabilities' components — "multiple installed XOs")
        const primaryRetrieval = await this.retriever.retrieveForPackage(mounted, selected.declaration.requiredComponents);
        if (!primaryRetrieval.ok)
            return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, primaryRetrieval.error) };
        let slices = [...primaryRetrieval.value];
        for (const auxiliaryId of request.auxiliaryCapabilityIds ?? []) {
            const auxiliaryDescriptor = context.capabilities.find(auxiliaryId)[0];
            if (!auxiliaryDescriptor)
                continue;
            const auxiliaryMounted = context.registry.get(auxiliaryDescriptor.packageName, auxiliaryDescriptor.packageVersion);
            if (!auxiliaryMounted)
                continue;
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
            if (!auxiliaryRetrieval.ok)
                return { ok: false, result: this.terminate(hookCtx, session, executionId, startedAt, auxiliaryRetrieval.error) };
            slices = [...slices, ...auxiliaryRetrieval.value];
        }
        await this.runHook(this.hooks?.onRetrieved, [hookCtx, slices], executionId);
        if (cancellation.isCancelled)
            return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };
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
        if (cancellation.isCancelled)
            return { ok: false, result: this.terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) };
        // 6. Prompt Assembly
        const priorTurns = this.memoryManager.get(session.sessionId);
        const providerRequest = this.promptAssembler.assemble({
            context: assembled,
            model: this.model,
            input: effectiveInput,
            ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
            priorTurns,
        });
        await this.runHook(this.hooks?.onBeforeAiCall, [hookCtx, providerRequest], executionId);
        return { ok: true, value: { session, plan, selected, assembled, providerRequest, effectiveInput, degraded } };
    }
    recordTurns(sessionId, input, responseContent) {
        this.memoryManager.append(sessionId, { role: 'user', content: input, recordedAt: this.now().toISOString() });
        this.memoryManager.append(sessionId, { role: 'assistant', content: responseContent, recordedAt: this.now().toISOString() });
    }
    async runHook(hook, args, executionId) {
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
    async runWorkflowRequest(request, graph, cancellation) {
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
        const finalSession = this.sessionManager.update(firstNodeReceipt
            ? withReceipt(session, firstNodeReceipt, this.now, { degraded: workflowResult.receipt.skippedNodeCount > 0 })
            : { ...session, status: 'completed', degraded: workflowResult.receipt.skippedNodeCount > 0, updatedAt: this.now().toISOString() });
        return { executionId, session: finalSession, response: structuredResponse, workflowResult };
    }
    terminate(hookCtx, session, executionId, startedAt, error) {
        const finalSession = session.status === 'planned' || session.status === 'pending' || session.status === 'executing' ? withFailed(session, this.now) : session;
        void this.runHook(this.hooks?.onError, [hookCtx, error], executionId);
        this.instrumentation?.recordExecutionOutcome(finalSession.status, this.now().getTime() - startedAt, { errorCode: error.code });
        return { executionId, session: this.sessionManager.update(finalSession), error };
    }
    terminateCancelled(hookCtx, session, executionId, startedAt, cancellation) {
        const isTimeout = cancellation.reason === 'timeout';
        const finalSession = isTimeout ? withTimedOut(session, this.now) : withCancelled(session, this.now);
        const error = new RuntimeError(isTimeout ? ErrorCode.RUNTIME_EXECUTION_TIMEOUT : ErrorCode.RUNTIME_EXECUTION_CANCELLED, isTimeout ? 'Execution timed out' : 'Execution was cancelled');
        void this.runHook(this.hooks?.onCancelled, [hookCtx, cancellation.reason], executionId);
        this.instrumentation?.recordExecutionOutcome(finalSession.status, this.now().getTime() - startedAt, {});
        return { executionId, session: this.sessionManager.update(finalSession), error };
    }
    /** Resolves as soon as either `promise` settles or `cancellation` fires. Note (see class doc comment): this stops the *pipeline* from waiting, not the underlying provider call, which `@xo/ai-core`'s `ProviderRequest` has no mechanism to actually abort. */
    raceCancellation(promise, cancellation) {
        if (cancellation.isCancelled)
            return Promise.resolve({ cancelled: true });
        return new Promise((resolve, reject) => {
            const onAbort = () => resolve({ cancelled: true });
            cancellation.signal.addEventListener('abort', onAbort, { once: true });
            promise.then((value) => {
                cancellation.signal.removeEventListener('abort', onAbort);
                resolve({ cancelled: false, value });
            }, (cause) => {
                cancellation.signal.removeEventListener('abort', onAbort);
                reject(cause instanceof Error ? cause : new Error(String(cause)));
            });
        });
    }
}
//# sourceMappingURL=execution-pipeline.js.map
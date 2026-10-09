import type { ProviderRequest, ProviderResponse } from '@xo/ai-core';
import type { RuntimeError } from '@xo/errors';
import type { AssembledContext } from '../context/context-assembler.js';
import type { ExecutionPlan } from '../execution/execution-plan.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionId } from '../ids.js';
import type { RetrievedSlice } from '../retrieval/retrieved-slice.js';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
export interface ExecutionHookContext {
    readonly executionId: ExecutionId;
    readonly request: ExecutionRequest;
}
/**
 * Lifecycle callbacks `ExecutionPipeline` fires at each named stage of
 * the execution flow, in the order the stages themselves run:
 * `onStart` → `onPlanned` → `onRetrieved` → `onContextAssembled` →
 * `onBeforeAiCall` → `onAfterAiCall` → `onReceipt`, with `onCancelled`/
 * `onError` firing instead of the remaining stages whenever an
 * execution is cancelled/fails partway through. Every hook is optional;
 * a hook throwing is caught and logged by `ExecutionPipeline`; it never
 * aborts the execution itself — hooks are for observing the pipeline,
 * not steering it (that's what `ExecutionMiddleware` is for).
 */
export interface ExecutionHooks {
    onStart?(ctx: ExecutionHookContext): void | Promise<void>;
    onPlanned?(ctx: ExecutionHookContext, plan: ExecutionPlan): void | Promise<void>;
    onRetrieved?(ctx: ExecutionHookContext, slices: readonly RetrievedSlice[]): void | Promise<void>;
    onContextAssembled?(ctx: ExecutionHookContext, context: AssembledContext): void | Promise<void>;
    onBeforeAiCall?(ctx: ExecutionHookContext, providerRequest: ProviderRequest): void | Promise<void>;
    onAfterAiCall?(ctx: ExecutionHookContext, providerResponse: ProviderResponse): void | Promise<void>;
    onReceipt?(ctx: ExecutionHookContext, receipt: ExecutionReceipt): void | Promise<void>;
    onCancelled?(ctx: ExecutionHookContext, reason: unknown): void | Promise<void>;
    onError?(ctx: ExecutionHookContext, error: RuntimeError): void | Promise<void>;
}
/**
 * Invokes `hook` (if defined) with `args`, swallowing (and, if `logger`
 * is given, logging) anything it throws or rejects with. A hook is an
 * observer, not a pipeline stage — its failure must never fail or alter
 * the execution it's observing.
 */
export declare function runHook<Args extends unknown[]>(hook: ((...args: Args) => void | Promise<void>) | undefined, args: Args, onHookError?: (error: unknown) => void): Promise<void>;
//# sourceMappingURL=execution-hooks.d.ts.map
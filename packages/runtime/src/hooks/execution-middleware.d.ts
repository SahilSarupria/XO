import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
/**
 * Onion-model middleware around the whole pipeline run — for
 * cross-cutting concerns that need to wrap the entire execution (e.g.
 * request/response logging, auth, rate limiting), as distinct from
 * {@link ExecutionHooks}' per-stage observation callbacks. A middleware
 * can inspect/modify the request before calling `next`, and inspect the
 * `ExecutionResult` after — including short-circuiting by not calling
 * `next` at all.
 */
export type ExecutionMiddleware = (request: ExecutionRequest, next: (request: ExecutionRequest) => Promise<ExecutionResult>) => Promise<ExecutionResult>;
/** Composes `middleware` (outermost first) around `core`, the pipeline's actual execution function. */
export declare function composeMiddleware(middleware: readonly ExecutionMiddleware[], core: (request: ExecutionRequest) => Promise<ExecutionResult>): (request: ExecutionRequest) => Promise<ExecutionResult>;
//# sourceMappingURL=execution-middleware.d.ts.map
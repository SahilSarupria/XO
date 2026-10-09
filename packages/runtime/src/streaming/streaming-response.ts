import type { ProviderStreamEvent } from '@xo/ai-core';
import type { ExecutionId } from '../ids.js';
import type { ExecutionResult } from '../execution/execution-result.js';

/**
 * The result of a streaming execution. `events` yields the same
 * `ProviderStreamEvent`s `@xo/ai-core`'s `ModelProvider.completeStream`
 * (or `CapabilityExecutor`'s single-call fallback for a provider that
 * doesn't implement streaming — see its own doc comment) would, as they
 * arrive; `result` resolves once the stream ends — successfully or not —
 * with the same `ExecutionResult` shape `ExecutionEngine.execute`
 * returns, receipt and session included. A caller only interested in the
 * incremental text can consume `events` alone and ignore `result`; a
 * caller that needs the final receipt/session should await `result`
 * after (or concurrently with) draining `events`.
 */
export interface StreamingResponse {
  readonly executionId: ExecutionId;
  readonly events: AsyncIterable<ProviderStreamEvent>;
  readonly result: Promise<ExecutionResult>;
}

import type { ProviderResponse } from '@xo/ai-core';
import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';

export type StopReason = 'end_turn' | 'max_tokens' | 'content_filtered' | 'error' | 'cancelled';

function toStopReason(finishReason: ProviderResponse['finishReason']): StopReason {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filtered';
    case 'error':
      return 'error';
  }
}

/**
 * Token accounting. Stage 1's `buildReceipt` always fills this with `{
 * promptTokens: 0, completionTokens: 0 }` (a real, honest placeholder —
 * Stage 1 never calls a provider); Stage 2's `buildExecutionReceipt`
 * fills it from `ResponseAssembler.assemble`'s mapping of
 * `@xo/ai-core`'s `ProviderResponse.usage` (`inputTokens`/
 * `outputTokens`) into this shape.
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Stage 2's "Structured Response" — the AI Capability Layer's raw output,
 * shaped and attributed back to the capability/package that produced it.
 * Field names (`promptTokens`/`completionTokens`, `stopReason`) are this
 * package's own vocabulary, kept stable across the swap from the
 * provisional stand-in `@xo/ai-core` to the real one — `assemble()` is
 * where the real package's field names (`ProviderResponse.usage.inputTokens`/
 * `outputTokens`, `finishReason`) get translated, so `ExecutionReceipt`
 * (Stage 1's shape, never rewritten) didn't need to change at all.
 */
export interface StructuredResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly capabilityId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  /** `true` if anything upstream degraded (budget trimming, `L0` fallback) before this response was produced. */
  readonly degraded: boolean;
}

export interface AssembleResponseParams {
  readonly providerResponse: ProviderResponse;
  readonly capability: CapabilityDescriptor;
  readonly degraded: boolean;
}

export class ResponseAssembler {
  assemble(params: AssembleResponseParams): StructuredResponse {
    return Object.freeze({
      content: params.providerResponse.text,
      stopReason: toStopReason(params.providerResponse.finishReason),
      usage: { promptTokens: params.providerResponse.usage.inputTokens, completionTokens: params.providerResponse.usage.outputTokens },
      capabilityId: params.capability.declaration.id,
      packageName: params.capability.packageName,
      packageVersion: params.capability.packageVersion,
      degraded: params.degraded,
    });
  }
}

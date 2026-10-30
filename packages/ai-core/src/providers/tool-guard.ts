import { AiError, ErrorCode } from '@xo/errors';
import type { ProviderRequest } from '../provider-types.js';

/**
 * Providers that have not implemented tool calling call this first. A request
 * that carries tools (or tool-role messages) must fail loudly: silently
 * dropping tools would let a caller believe a decision-tree tool was
 * available to the model when it was not, which corrupts any evaluation.
 */
export function assertNoToolCalling(providerId: string, request: ProviderRequest): void {
  const hasTools = request.tools !== undefined && request.tools.length > 0;
  const hasToolMessages = request.messages.some((m) => m.role === 'tool' || (m.toolCalls !== undefined && m.toolCalls.length > 0));
  if (hasTools || hasToolMessages) {
    throw new AiError(
      ErrorCode.AI_PROVIDER_REQUEST_FAILED,
      `provider "${providerId}" does not implement tool calling in this build; use the anthropic provider for tool-enabled requests`,
    );
  }
}

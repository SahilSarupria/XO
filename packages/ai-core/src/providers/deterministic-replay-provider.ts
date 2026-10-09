import { createHash } from 'node:crypto';
import { AiError, ErrorCode } from '@xo/errors';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '../provider-types.js';

function hashRequest(request: ProviderRequest): string {
  const canonical = JSON.stringify({ model: request.model, messages: request.messages, responseSchema: request.responseSchema ?? null });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ReplayFixture {
  readonly response: ProviderResponse;
}

/**
 * A provider backed by a fixed map of `request hash -> recorded
 * response`, rather than a live vendor call. This is what makes this
 * package's own tests (and, until a networked environment with real API
 * credentials is available, any caller's tests) actually runnable and
 * deterministic — "deterministic replay for tests" and "mock providers"
 * from the module spec are the same mechanism here: recording mode turns
 * a real provider's responses into fixtures; replay mode serves them back
 * with zero network calls and zero nondeterminism.
 *
 * A request hash that has no matching fixture throws
 * `AI_REPLAY_FIXTURE_MISSING` rather than silently returning empty output
 * — a missing fixture in a test is a signal the test needs a fixture
 * added, never something to paper over.
 */
export class DeterministicReplayProvider implements ModelProvider {
  readonly id = 'deterministic-replay' as const;
  private readonly fixtures = new Map<string, ReplayFixture>();

  constructor(
    private readonly descriptor: ProviderCapabilityDescriptor = {
      providerId: 'deterministic-replay',
      models: ['replay-1'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      maxContextTokens: 200_000,
    },
  ) {}

  /** Records a canned response for a specific request shape — call this in test setup before exercising code that calls `complete()`. */
  record(request: ProviderRequest, response: ProviderResponse): void {
    this.fixtures.set(hashRequest(request), { response });
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return this.descriptor;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const key = hashRequest(request);
    const fixture = this.fixtures.get(key);
    if (!fixture) {
      throw new AiError(ErrorCode.AI_REPLAY_FIXTURE_MISSING, `No replay fixture recorded for this exact request (model="${request.model}", ${request.messages.length} message(s))`);
    }
    return fixture.response;
  }

  async *completeStream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const response = await this.complete(request);
    yield { type: 'text_delta', delta: response.text };
    yield { type: 'done', usage: response.usage, finishReason: response.finishReason };
  }
}

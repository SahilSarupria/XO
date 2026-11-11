import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, type AiError } from '@xo/errors';
import { OpenAiProvider } from '../../src/providers/openai-provider.js';
import { AnthropicProvider } from '../../src/providers/anthropic-provider.js';
import { AzureOpenAiProvider } from '../../src/providers/azure-openai-provider.js';
import { OllamaProvider } from '../../src/providers/ollama-provider.js';
import { redactVendorText, parseRetryAfterMs } from '../../src/providers/http-transport.js';
import { getProviderFailure } from '../../src/provider-errors.js';
import type { ProviderRequest } from '../../src/provider-types.js';
import { hangUntilAborted, json, scriptedFetch } from './gemini-helpers.js';

const req = (model: string, extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model,
  maxOutputTokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const instant = { sleep: async (): Promise<void> => {}, jitter: (ms: number): number => ms };

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const failure = getProviderFailure(error);
    assert.ok(failure, `expected a classified provider failure, got ${String(error)}`);
    return { error: error as AiError, failure };
  }
  assert.fail('expected rejection');
}

test('backoff is abort-aware: aborting during a long default backoff sleep ends promptly with no further network call', async () => {
  const f = scriptedFetch([json({ error: { message: 'busy' } }, 503)]);
  // No injected sleep: the REAL default sleep with a 60s backoff. If it were not abort-aware this test would hang.
  const provider = new OpenAiProvider({
    apiKey: 'sk-TESTSECRET0123456789abcdefghij',
    fetchImpl: f.fetchImpl,
    retry: { maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 60_000, jitter: (ms) => ms },
  });
  const controller = new AbortController();
  const pending = failureOf(provider.complete(req('gpt-4o', { signal: controller.signal })));
  for (let i = 0; i < 10 && f.calls.length < 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 1);
  controller.abort();
  const winner = await Promise.race([pending, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000).unref())]);
  assert.notEqual(winner, 'hung', 'abort must interrupt the backoff sleep');
  if (winner !== 'hung') assert.equal(winner.failure.category, 'aborted');
  assert.equal(f.calls.length, 1, 'no attempt is made after the abort');
});

test('OpenAI insufficient_quota (HTTP 429) is quota_exhausted: AI_RATE_LIMITED, never retried', async () => {
  const f = scriptedFetch([
    json({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429),
  ]);
  const { error, failure } = await failureOf(
    new OpenAiProvider({ apiKey: 'sk-TESTSECRET0123456789abcdefghij', fetchImpl: f.fetchImpl, retry: instant }).complete(req('gpt-4o')),
  );
  assert.equal(failure.category, 'quota_exhausted');
  assert.equal(error.code, ErrorCode.AI_RATE_LIMITED);
  assert.equal(f.calls.length, 1);
});

test('Azure 400 content_filter is content_blocked and not retried', async () => {
  const f = scriptedFetch([json({ error: { message: 'The prompt was filtered', code: 'content_filter' } }, 400)]);
  const { failure } = await failureOf(
    new AzureOpenAiProvider({
      apiKey: 'azure-TESTKEY-0123456789abcdef',
      endpoint: 'https://e.openai.azure.com',
      fetchImpl: f.fetchImpl,
      retry: instant,
    }).complete(req('dep')),
  );
  assert.equal(failure.category, 'content_blocked');
  assert.equal(f.calls.length, 1);
});

test('Anthropic 529 "overloaded" is transient and retried (bounded)', async () => {
  const f = scriptedFetch([json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)]);
  const { failure } = await failureOf(
    new AnthropicProvider({
      apiKey: 'sk-ant-TESTSECRET0123456789abcdef',
      fetchImpl: f.fetchImpl,
      retry: { maxRetries: 2, ...instant },
    }).complete(req('claude-sonnet-4-6')),
  );
  assert.equal(failure.category, 'transient');
  assert.equal(failure.providerCode, 'overloaded_error');
  assert.equal(f.calls.length, 3);
});

test('Ollama string-shaped error bodies are classified by status (404 → unsupported_model)', async () => {
  const f = scriptedFetch([json({ error: "model 'nope' not found" }, 404)]);
  const { failure } = await failureOf(new OllamaProvider({ fetchImpl: f.fetchImpl, retry: instant }).complete(req('nope')));
  assert.equal(failure.category, 'unsupported_model');
  assert.equal(f.calls.length, 1);
});

test('hung request is bounded by the per-request timeout even with real timers (short timeout)', async () => {
  const f = scriptedFetch([hangUntilAborted]);
  const { failure } = await failureOf(
    new OllamaProvider({ fetchImpl: f.fetchImpl, timeoutMs: 25, retry: { maxRetries: 0, ...instant } }).complete(req('m')),
  );
  assert.equal(failure.category, 'timeout');
});

test('vendor text echoing OTHER vendors’ key shapes (sk-…, Bearer …) is redacted, not just the configured key', async () => {
  const f = scriptedFetch([
    json(
      {
        error: {
          message: 'Incorrect API key provided: sk-proj-abcdef1234567890. Authorization: Bearer ZZtoken1234567890',
          code: 'invalid_api_key',
        },
      },
      401,
    ),
  ]);
  const { error, failure } = await failureOf(
    new OpenAiProvider({ apiKey: 'sk-TESTSECRET0123456789abcdefghij', fetchImpl: f.fetchImpl, retry: instant }).complete(req('gpt-4o')),
  );
  for (const surface of [error.message, JSON.stringify(failure)]) {
    assert.ok(!surface.includes('abcdef1234567890'), surface);
    assert.ok(!surface.includes('ZZtoken1234567890'), surface);
  }
  assert.match(failure.providerMessage ?? '', /\[REDACTED\]/);
});

test('redactVendorText / parseRetryAfterMs unit behaviour', () => {
  assert.equal(redactVendorText('a sk-ant-abc123456 b', []), 'a [REDACTED] b');
  assert.equal(redactVendorText('Bearer abcdef123456', []), 'Bearer [REDACTED]');
  assert.ok(!redactVendorText('Authorization: Bearer abcdef123456', []).includes('abcdef123456'));
  assert.equal(redactVendorText('nothing secret here', ['not-present-secret']), 'nothing secret here');
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('not a date or number'), undefined);
});

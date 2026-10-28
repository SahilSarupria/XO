import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../../src/providers/gemini-provider.js';
import { AnthropicProvider } from '../../src/providers/anthropic-provider.js';
import { OpenAiProvider } from '../../src/providers/openai-provider.js';
import { AzureOpenAiProvider } from '../../src/providers/azure-openai-provider.js';
import { OllamaProvider } from '../../src/providers/ollama-provider.js';
import { getProviderFailure, type ProviderFailureCategory } from '../../src/provider-errors.js';
import type { ModelProvider, ProviderRequest } from '../../src/provider-types.js';
import { TEST_API_KEY, hangUntilAborted, json, okText, scriptedFetch, type Step } from './gemini-helpers.js';

/**
 * One behavioural contract, run against every adapter with a scripted `fetchImpl` (no network, no credits). Gemini is the golden
 * reference: if an adapter disagrees with it here, the adapter is wrong.
 */

const RAW_SENTINEL = 'RAW-VENDOR-BODY-SENTINEL-7f3a';

interface Harness {
  readonly name: string;
  readonly model: string;
  /** Credential the adapter holds, or `undefined` for credential-less adapters (Ollama). */
  readonly secret: string | undefined;
  readonly make: (fetchImpl: typeof fetch, o: { maxRetries: number; timeoutMs?: number; sleeps?: number[] }) => ModelProvider;
  /** A successful 200 whose answer is `text`. */
  readonly ok: (text: string, o?: { usage?: boolean; truncated?: boolean }) => Response;
  /** A 200 where the vendor refused / filtered the output (undefined = this vendor has no such signal). */
  readonly blocked?: () => Response;
  /** A 200 with no usable text. */
  readonly empty: () => Response;
  /** Whether a JSON `null` 200 body is expected to be handled without a TypeError (Gemini's golden reference does not guard it; not changed here). */
  readonly toleratesNullBody: boolean;
}

const retryOf = (o: { maxRetries: number; sleeps?: number[] }) => ({
  maxRetries: o.maxRetries,
  sleep: async (ms: number): Promise<void> => {
    o.sleeps?.push(ms);
  },
  jitter: (ms: number): number => ms,
});

const HARNESSES: readonly Harness[] = [
  {
    name: 'gemini',
    model: 'gemini-3.5-flash-lite',
    secret: TEST_API_KEY,
    make: (fetchImpl, o) =>
      new GeminiProvider({ apiKey: TEST_API_KEY, fetchImpl, retry: retryOf(o), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }),
    ok: (text, o = {}) =>
      okText(
        text,
        o.usage === false ? null : { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
        o.truncated ? 'MAX_TOKENS' : 'STOP',
      ),
    blocked: () => okText('x', undefined, 'SAFETY'),
    empty: () => okText('   '),
    toleratesNullBody: false,
  },
  {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    secret: 'sk-ant-TESTSECRET0123456789abcdef',
    make: (fetchImpl, o) =>
      new AnthropicProvider({
        apiKey: 'sk-ant-TESTSECRET0123456789abcdef',
        fetchImpl,
        retry: retryOf(o),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      }),
    ok: (text, o = {}) =>
      json({
        content: [{ type: 'text', text }],
        ...(o.usage === false ? {} : { usage: { input_tokens: 11, output_tokens: 4 } }),
        stop_reason: o.truncated ? 'max_tokens' : 'end_turn',
      }),
    blocked: () => json({ content: [], usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: 'refusal' }),
    empty: () => json({ content: [{ type: 'text', text: '' }], usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: 'end_turn' }),
    toleratesNullBody: true,
  },
  {
    name: 'openai',
    model: 'gpt-4o',
    secret: 'sk-TESTSECRET0123456789abcdefghij',
    make: (fetchImpl, o) =>
      new OpenAiProvider({
        apiKey: 'sk-TESTSECRET0123456789abcdefghij',
        fetchImpl,
        retry: retryOf(o),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      }),
    ok: (text, o = {}) =>
      json({
        model: 'gpt-4o-2024-08-06',
        choices: [{ message: { content: text }, finish_reason: o.truncated ? 'length' : 'stop' }],
        ...(o.usage === false ? {} : { usage: { prompt_tokens: 11, completion_tokens: 4 } }),
      }),
    blocked: () =>
      json({
        model: 'gpt-4o',
        choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 3, completion_tokens: 0 },
      }),
    empty: () =>
      json({
        model: 'gpt-4o',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 0 },
      }),
    toleratesNullBody: true,
  },
  {
    name: 'azure-openai',
    model: 'my-gpt4o-deployment',
    secret: 'azure-TESTKEY-0123456789abcdef',
    make: (fetchImpl, o) =>
      new AzureOpenAiProvider({
        apiKey: 'azure-TESTKEY-0123456789abcdef',
        endpoint: 'https://example-resource.openai.azure.com',
        fetchImpl,
        retry: retryOf(o),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      }),
    ok: (text, o = {}) =>
      json({
        choices: [{ message: { content: text }, finish_reason: o.truncated ? 'length' : 'stop' }],
        ...(o.usage === false ? {} : { usage: { prompt_tokens: 11, completion_tokens: 4 } }),
      }),
    blocked: () =>
      json({
        choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 3, completion_tokens: 0 },
      }),
    empty: () =>
      json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 0 } }),
    toleratesNullBody: true,
  },
  {
    name: 'ollama',
    model: 'llama3.1:8b',
    secret: undefined,
    make: (fetchImpl, o) => new OllamaProvider({ fetchImpl, retry: retryOf(o), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }),
    ok: (text, o = {}) =>
      json({
        message: { role: 'assistant', content: text },
        ...(o.usage === false ? {} : { prompt_eval_count: 11, eval_count: 4 }),
        done: true,
        done_reason: o.truncated ? 'length' : 'stop',
      }),
    empty: () =>
      json({ message: { role: 'assistant', content: '' }, prompt_eval_count: 3, eval_count: 0, done: true, done_reason: 'stop' }),
    toleratesNullBody: true,
  },
];

const request = (h: Harness, extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: h.model,
  maxOutputTokens: 256,
  temperature: 0,
  messages: [
    { role: 'system', content: 'You are an extractor.' },
    { role: 'user', content: 'PROMPT-CONTENT-SENTINEL hello' },
  ],
  ...extra,
});

/** A vendor-shaped-enough error body: every adapter reads `error.message`, and none treats this as quota/auth/etc. by itself. */
const errorJson = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  json({ error: { message: 'request was not accepted', ...extra } }, status, headers);

async function failureOf(
  promise: Promise<unknown>,
): Promise<{ error: Error; failure: NonNullable<ReturnType<typeof getProviderFailure>> }> {
  try {
    await promise;
  } catch (error) {
    const failure = getProviderFailure(error);
    assert.ok(
      failure,
      `expected a classified provider failure, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return { error: error as Error, failure };
  }
  assert.fail('expected the call to reject');
}

/** Lets pending promise continuations run (real `setImmediate`; only `setTimeout` is mocked in the timer tests). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

for (const h of HARNESSES) {
  // ---- non-retryable statuses ----------------------------------------------------
  for (const [status, category] of [
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'permission_denied'],
    [404, 'unsupported_model'],
  ] as const) {
    test(`${h.name}: HTTP ${status} → ${category}, non-retryable (exactly one call)`, async () => {
      const f = scriptedFetch([errorJson(status)]);
      const provider = h.make(f.fetchImpl, { maxRetries: 2 });
      const { failure } = await failureOf(provider.complete(request(h)));
      assert.equal(failure.category, category);
      assert.equal(failure.httpStatus, status);
      assert.equal(f.calls.length, 1, 'a non-retryable status must not be retried');
    });
  }

  // ---- 429 / Retry-After ---------------------------------------------------------
  test(`${h.name}: 429 with Retry-After is retried (honouring the wait) and then succeeds`, async () => {
    const sleeps: number[] = [];
    const f = scriptedFetch([errorJson(429, {}, { 'retry-after': '2' }), h.ok('{"a":"b"}')]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2, sleeps });
    const res = await provider.complete(request(h));
    assert.equal(res.text, '{"a":"b"}');
    assert.equal(f.calls.length, 2);
    assert.equal(res.meta?.attempts, 2);
    assert.ok(sleeps.length === 1 && sleeps[0]! >= 2000, `must wait at least the vendor's Retry-After; slept ${JSON.stringify(sleeps)}`);
  });

  test(`${h.name}: persistent 429 is retried only up to the bound, then classified rate_limited`, async () => {
    const f = scriptedFetch([errorJson(429, {}, { 'retry-after': '1' })]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const { failure } = await failureOf(provider.complete(request(h)));
    assert.equal(failure.category, 'rate_limited');
    assert.equal(failure.retryAfterMs, 1000);
    assert.equal(f.calls.length, 3, '1 attempt + 2 bounded retries');
  });

  test(`${h.name}: a Retry-After beyond the cap fails fast instead of sleeping (one call)`, async () => {
    const f = scriptedFetch([errorJson(429, {}, { 'retry-after': '3600' })]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const { failure } = await failureOf(provider.complete(request(h)));
    assert.equal(failure.category, 'rate_limited');
    assert.equal(f.calls.length, 1);
  });

  // ---- 5xx / network ---------------------------------------------------------------
  test(`${h.name}: HTTP 503 is retried bounded, then classified transient`, async () => {
    const f = scriptedFetch([errorJson(503)]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const { failure } = await failureOf(provider.complete(request(h)));
    assert.equal(failure.category, 'transient');
    assert.equal(f.calls.length, 3);
  });

  test(`${h.name}: a transient 503 followed by success is recovered by the adapter`, async () => {
    const f = scriptedFetch([errorJson(503), h.ok('{"a":"b"}')]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const res = await provider.complete(request(h));
    assert.equal(res.meta?.attempts, 2);
    assert.equal(f.calls.length, 2);
  });

  test(`${h.name}: a network error is retried bounded, then classified transient`, async () => {
    const f = scriptedFetch([new Error('ECONNRESET')]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const { failure } = await failureOf(provider.complete(request(h)));
    assert.equal(failure.category, 'transient');
    assert.equal(f.calls.length, 3);
  });

  test(`${h.name}: maxRetries 0 disables retry`, async () => {
    const f = scriptedFetch([errorJson(503)]);
    const provider = h.make(f.fetchImpl, { maxRetries: 0 });
    await failureOf(provider.complete(request(h)));
    assert.equal(f.calls.length, 1);
  });

  // ---- timeout (fake timers) -------------------------------------------------------
  test(`${h.name}: a hung request times out via the per-request timeout (fake timers), then is retried bounded`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = scriptedFetch([hangUntilAborted]);
    const provider = h.make(f.fetchImpl, { maxRetries: 1, timeoutMs: 1000 });
    let settled = false;
    const pending = failureOf(provider.complete(request(h))).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await flush();
      t.mock.timers.tick(1000);
    }
    const { failure } = await pending;
    assert.equal(failure.category, 'timeout');
    assert.equal(f.calls.length, 2, 'timeout is transport-retryable: 1 attempt + 1 bounded retry');
  });

  // ---- caller abort ------------------------------------------------------------------
  test(`${h.name}: a caller abort mid-flight stops waiting and is NOT retried`, async () => {
    const f = scriptedFetch([hangUntilAborted]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const controller = new AbortController();
    const pending = failureOf(provider.complete(request(h, { signal: controller.signal })));
    await flush();
    assert.equal(f.calls.length, 1);
    controller.abort();
    const { failure } = await pending;
    assert.equal(failure.category, 'aborted');
    assert.equal(f.calls.length, 1, 'an abort must not trigger another attempt');
  });

  test(`${h.name}: an already-aborted signal makes zero network calls`, async () => {
    const f = scriptedFetch([h.ok('{}')]);
    const provider = h.make(f.fetchImpl, { maxRetries: 2 });
    const controller = new AbortController();
    controller.abort();
    const { failure } = await failureOf(provider.complete(request(h, { signal: controller.signal })));
    assert.equal(failure.category, 'aborted');
    assert.equal(f.calls.length, 0);
  });

  // ---- response normalization -------------------------------------------------------
  test(`${h.name}: a normal success reports usage as known`, async () => {
    const f = scriptedFetch([h.ok('{"a":"b"}')]);
    const res = await h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h));
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.usageKnown, true);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 4 });
    assert.equal(res.meta?.attempts, 1);
  });

  test(`${h.name}: missing usage → usageKnown false (a {0,0} placeholder, never a TypeError)`, async () => {
    const f = scriptedFetch([h.ok('{"a":"b"}', { usage: false })]);
    const res = await h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h));
    assert.equal(res.usageKnown, false);
    assert.deepEqual(res.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(res.text, '{"a":"b"}');
  });

  test(`${h.name}: a truncated answer is returned with finishReason 'length'`, async () => {
    const f = scriptedFetch([h.ok('{"a":"b', { truncated: true })]);
    const res = await h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h));
    assert.equal(res.finishReason, 'length');
  });

  test(`${h.name}: empty output → empty_response`, async () => {
    const f = scriptedFetch([h.empty()]);
    const { failure } = await failureOf(h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h)));
    assert.equal(failure.category, 'empty_response');
  });

  if (h.blocked) {
    test(`${h.name}: a vendor refusal / content filter → content_blocked (not retried)`, async () => {
      const f = scriptedFetch([h.blocked!()]);
      const { failure } = await failureOf(h.make(f.fetchImpl, { maxRetries: 2 }).complete(request(h)));
      assert.equal(failure.category, 'content_blocked');
      assert.equal(f.calls.length, 1);
    });
  }

  test(`${h.name}: structurally odd 200 bodies never surface a TypeError`, async () => {
    const bodies: Step[] = [json({}), json([]), json('text'), json({ choices: 'nope', content: 7, message: 3, candidates: 'x' })];
    if (h.toleratesNullBody) bodies.push(json(null));
    for (const body of bodies) {
      const f = scriptedFetch([body]);
      const outcome = await h
        .make(f.fetchImpl, { maxRetries: 0 })
        .complete(request(h))
        .then(
          () => 'resolved' as const,
          (error: unknown) => error,
        );
      assert.notEqual(outcome, 'resolved', 'an unusable body must not look like a success');
      assert.ok(getProviderFailure(outcome), `expected a classified provider failure, got ${String(outcome)}`);
    }
  });

  test(`${h.name}: a non-JSON 200 body → malformed_response (never the body itself)`, async () => {
    const f = scriptedFetch([new Response(`<html>${RAW_SENTINEL}</html>`, { status: 200 })]);
    const { error, failure } = await failureOf(h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h)));
    assert.equal(failure.category, 'malformed_response');
    assert.ok(!error.message.includes(RAW_SENTINEL));
    assert.ok(!JSON.stringify(failure).includes(RAW_SENTINEL));
  });

  // ---- secrets & raw bodies never reach errors ---------------------------------------
  test(`${h.name}: error messages and context contain no credential and no raw vendor body`, async () => {
    const secret = h.secret;
    const echoed = secret ? `Incorrect API key provided: ${secret}` : 'bad key';
    const attempts: Step[] = [
      // JSON error body that echoes the key in its message and carries extra, non-message fields
      json({ error: { message: echoed, code: 'invalid_api_key' }, debug: RAW_SENTINEL, trace: secret ?? 'none' }, 401),
      // non-JSON error body containing both
      new Response(`${RAW_SENTINEL} ${secret ?? ''}`, { status: 500 }),
      new Response(`${RAW_SENTINEL} ${secret ?? ''}`, { status: 400 }),
      // network error that echoes the key (a transport error is not a vendor body; only the credential must never survive)
      new Error(`connect failed: key=${secret ?? 'none'}`),
    ];
    for (const step of attempts) {
      const f = scriptedFetch([step]);
      const { error, failure } = await failureOf(h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h)));
      const surfaces = [error.message, JSON.stringify(failure), String((error as { cause?: unknown }).cause ?? ''), error.stack ?? ''];
      for (const surface of surfaces) {
        assert.ok(!surface.includes(RAW_SENTINEL), `raw vendor body leaked: ${surface.slice(0, 120)}`);
        if (secret) assert.ok(!surface.includes(secret), `credential leaked: ${surface.slice(0, 120)}`);
      }
    }
  });

  test(`${h.name}: the request itself carries the temperature it was given (0 stays 0)`, async () => {
    const f = scriptedFetch([h.ok('{"a":"b"}')]);
    await h.make(f.fetchImpl, { maxRetries: 0 }).complete(request(h, { temperature: 0 }));
    assert.ok(f.calls[0]!.rawBody.includes('"temperature":0'), `temperature 0 must be forwarded: ${f.calls[0]!.rawBody.slice(0, 200)}`);
  });
}

// ---- wire format of the four hardened adapters is unchanged ----------------------------
test('wire format: anthropic', async () => {
  const f = scriptedFetch([HARNESSES[1]!.ok('{}')]);
  await HARNESSES[1]!
    .make(f.fetchImpl, { maxRetries: 0 })
    .complete(request(HARNESSES[1]!, { temperature: 0.3, responseSchema: { type: 'object' } }));
  const c = f.calls[0]!;
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], 'sk-ant-TESTSECRET0123456789abcdef');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(Object.keys(c.body), ['model', 'max_tokens', 'system', 'messages', 'temperature']);
  assert.match(
    String(c.body['system']),
    /^You are an extractor\.\n\nRespond with JSON matching this schema exactly:\n\{"type":"object"\}$/,
  );
  assert.deepEqual(c.body['messages'], [{ role: 'user', content: 'PROMPT-CONTENT-SENTINEL hello' }]);
});

test('wire format: openai', async () => {
  const f = scriptedFetch([HARNESSES[2]!.ok('{}')]);
  await HARNESSES[2]!.make(f.fetchImpl, { maxRetries: 0 }).complete(request(HARNESSES[2]!, { responseSchema: { type: 'object' } }));
  const c = f.calls[0]!;
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.headers['authorization'], 'Bearer sk-TESTSECRET0123456789abcdefghij');
  assert.deepEqual(Object.keys(c.body), ['model', 'max_tokens', 'temperature', 'messages', 'response_format']);
  assert.deepEqual(c.body['response_format'], {
    type: 'json_schema',
    json_schema: { name: 'capability_output', schema: { type: 'object' }, strict: true },
  });
});

test('wire format: azure-openai', async () => {
  const f = scriptedFetch([HARNESSES[3]!.ok('{}')]);
  await HARNESSES[3]!.make(f.fetchImpl, { maxRetries: 0 }).complete(request(HARNESSES[3]!));
  const c = f.calls[0]!;
  assert.equal(
    c.url,
    'https://example-resource.openai.azure.com/openai/deployments/my-gpt4o-deployment/chat/completions?api-version=2024-06-01',
  );
  assert.equal(c.headers['api-key'], 'azure-TESTKEY-0123456789abcdef');
  assert.deepEqual(
    Object.keys(c.body),
    ['max_tokens', 'temperature', 'messages'],
    'Azure addresses the deployment in the URL: no `model` member',
  );
});

test('wire format: ollama', async () => {
  const f = scriptedFetch([HARNESSES[4]!.ok('{}')]);
  await HARNESSES[4]!.make(f.fetchImpl, { maxRetries: 0 }).complete(request(HARNESSES[4]!));
  const c = f.calls[0]!;
  assert.equal(c.url, 'http://localhost:11434/api/chat');
  assert.deepEqual(Object.keys(c.body), ['model', 'stream', 'messages', 'options']);
  assert.equal(c.body['stream'], false);
  assert.deepEqual(c.body['options'], { temperature: 0, num_predict: 256 });
});

test('descriptors are unchanged: ollama is not structured-output capable (so never router-eligible)', () => {
  assert.equal(new OllamaProvider().describeCapabilities().supportsStructuredOutput, false);
  assert.equal(new OpenAiProvider({ apiKey: 'k' }).describeCapabilities().supportsStructuredOutput, true);
  assert.equal(new AnthropicProvider({ apiKey: 'k' }).describeCapabilities().supportsStructuredOutput, true);
  assert.equal(new AzureOpenAiProvider({ apiKey: 'k', endpoint: 'https://x' }).describeCapabilities().supportsStructuredOutput, true);
});

test('configuration errors are classified invalid_request', () => {
  for (const make of [
    () => new OpenAiProvider({ apiKey: 'k', timeoutMs: 0 }),
    () => new AnthropicProvider({ apiKey: 'k', retry: { maxRetries: 9 } }),
    () => new OllamaProvider({ timeoutMs: 1.5 }),
  ]) {
    assert.throws(make, (e: unknown) => getProviderFailure(e)?.category === ('invalid_request' satisfies ProviderFailureCategory));
  }
  mock.reset();
});

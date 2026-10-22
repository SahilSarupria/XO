import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from '../../src/providers/gemini-provider.js';
import { getProviderFailure } from '../../src/provider-errors.js';
import type { ProviderRequest } from '../../src/provider-types.js';
import {
  TEST_API_KEY,
  capturingLogger,
  errorBody,
  hangUntilAborted,
  json,
  noSleep,
  okText,
  scriptedFetch,
  type Step,
} from './gemini-helpers.js';

const MODEL = 'gemini-3.5-flash-lite';
const baseRequest: ProviderRequest = {
  model: MODEL,
  maxOutputTokens: 256,
  messages: [
    { role: 'system', content: 'You are an extractor.' },
    { role: 'user', content: 'PROMPT-CONTENT-SENTINEL hello' },
  ],
};
const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } as const;

function make(steps: Step[], opts: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) {
  const f = scriptedFetch(steps);
  const provider = new GeminiProvider({ apiKey: TEST_API_KEY, fetchImpl: f.fetchImpl, retry: { maxRetries: 0 }, ...opts });
  return { provider, ...f };
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const failure = getProviderFailure(error);
    assert.ok(failure, `expected a provider failure, got ${String(error)}`);
    return { error: error as Error, failure };
  }
  assert.fail('expected rejection');
}

// 3. request mapping ------------------------------------------------------------
test('maps messages: system -> systemInstruction, assistant -> model role, key only in header', async () => {
  const { provider, calls } = make([okText('hi')]);
  await provider.complete({
    ...baseRequest,
    temperature: 0.2,
    messages: [...baseRequest.messages, { role: 'assistant', content: 'earlier' }, { role: 'user', content: 'again' }],
  });
  const call = calls[0]!;
  assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
  assert.equal(call.headers['x-goog-api-key'], TEST_API_KEY);
  assert.ok(!call.url.includes(TEST_API_KEY) && !call.url.includes('key='), 'key must never be in the URL');
  assert.ok(!call.rawBody.includes(TEST_API_KEY), 'key must never be in the body');
  assert.deepEqual(call.body['systemInstruction'], { parts: [{ text: 'You are an extractor.' }] });
  const contents = call.body['contents'] as { role: string }[];
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model', 'user'],
  );
  assert.deepEqual(call.body['generationConfig'], { maxOutputTokens: 256, temperature: 0.2 });
});

// 4. success + 15. usage -------------------------------------------------------
test('successful text inference normalizes text, usage, finish reason and call metadata', async () => {
  const { provider } = make([okText('hello world', { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 })]);
  const res = await provider.complete({ ...baseRequest, requestId: 'req-1' });
  assert.equal(res.text, 'hello world');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 4 });
  assert.equal(res.usageKnown, true);
  assert.equal(res.modelUsed, MODEL);
  assert.equal(res.meta?.requestId, 'req-1');
  assert.equal(res.meta?.providerId, 'gemini');
  assert.equal(res.meta?.attempts, 1);
  assert.equal(res.meta?.rawFinishReason, 'STOP');
});

test('output tokens include hidden reasoning (thoughts) tokens', async () => {
  const { provider } = make([okText('x', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 40, totalTokenCount: 55 })]);
  assert.deepEqual((await provider.complete(baseRequest)).usage, { inputTokens: 10, outputTokens: 45 });
});

test('usage is marked unknown (not fabricated) when the vendor omits it', async () => {
  const { provider } = make([okText('x', null)]);
  const res = await provider.complete(baseRequest);
  assert.equal(res.usageKnown, false);
  assert.deepEqual(res.usage, { inputTokens: 0, outputTokens: 0 });
});

test('thought parts are excluded from the returned text', async () => {
  const { provider } = make([
    json({ candidates: [{ content: { parts: [{ text: 'secret reasoning', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }] }),
  ]);
  assert.equal((await provider.complete(baseRequest)).text, 'answer');
});

// 5. structured output ----------------------------------------------------------
test('structured output: schema is mapped to the Gemini subset and the response is validated locally', async () => {
  const { provider, calls } = make([okText('{"a":"x"}')]);
  const res = await provider.complete({ ...baseRequest, responseSchema: { ...schema, additionalProperties: false, $schema: 'x' } });
  assert.equal(res.text, '{"a":"x"}');
  const gc = calls[0]!.body['generationConfig'] as Record<string, unknown>;
  assert.equal(gc['responseMimeType'], 'application/json');
  assert.deepEqual(gc['responseSchema'], { type: 'OBJECT', properties: { a: { type: 'STRING' } }, required: ['a'] });
});

test('structured output: schema-invalid, non-JSON and truncated bodies are malformed_response, not success', async () => {
  for (const [text, finish, needle] of [
    ['{"b":1}', 'STOP', 'schema validation'],
    ['not json', 'STOP', 'not valid JSON'],
    ['{"a":"unterminated', 'MAX_TOKENS', 'truncated'],
  ] as const) {
    const { provider } = make([okText(text, undefined, finish)]);
    const { failure, error } = await failureOf(provider.complete({ ...baseRequest, responseSchema: schema }));
    assert.equal(failure.category, 'malformed_response');
    assert.ok(error.message.includes(needle), error.message);
  }
});

test('schema-validation errors never echo the offending response values', async () => {
  const { provider } = make([okText('{"a":12345}', undefined)]);
  const { error } = await failureOf(provider.complete({ ...baseRequest, responseSchema: schema }));
  assert.ok(!error.message.includes('12345'));
});

// 6. empty / blocked ------------------------------------------------------------
test('empty text, missing candidates, blocked prompts and filtered output are failures, never usable inference', async () => {
  const cases: [Step, string][] = [
    [okText('   '), 'empty_response'],
    [json({ candidates: [] }), 'empty_response'],
    [json({}), 'empty_response'],
    [json({ promptFeedback: { blockReason: 'SAFETY' } }), 'content_blocked'],
    [json({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'SAFETY' }] }), 'content_blocked'],
    [json({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'RECITATION' }] }), 'content_blocked'],
    [json({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }), 'malformed_response'],
  ];
  for (const [step, category] of cases) {
    const { provider, calls } = make([step], { retry: { maxRetries: 2, ...noSleep } });
    const { failure } = await failureOf(provider.complete(baseRequest));
    assert.equal(failure.category, category);
    assert.equal(calls.length, 1, `${category} must not be retried`);
  }
});

// 7. auth + invalid request -----------------------------------------------------
test('authentication, permission, invalid-request and unsupported-model HTTP errors are classified and never retried', async () => {
  const cases: [Response, string][] = [
    [errorBody(401, 'UNAUTHENTICATED', 'bad creds'), 'authentication'],
    [errorBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'), 'authentication'],
    [errorBody(403, 'PERMISSION_DENIED', 'nope'), 'permission_denied'],
    [errorBody(400, 'FAILED_PRECONDITION', 'Free tier is not available in your country. Enable billing.'), 'permission_denied'],
    [errorBody(400, 'INVALID_ARGUMENT', 'bad field'), 'invalid_request'],
    [errorBody(404, 'NOT_FOUND', 'model not found'), 'unsupported_model'],
    [errorBody(501, 'UNIMPLEMENTED', 'nope'), 'unsupported_feature'],
  ];
  for (const [res, category] of cases) {
    const { provider, calls } = make([res], { retry: { maxRetries: 3, ...noSleep } });
    const { failure } = await failureOf(provider.complete(baseRequest));
    assert.equal(failure.category, category);
    assert.equal(calls.length, 1, `${category} must not be retried`);
  }
});

// 8. rate limit / quota ---------------------------------------------------------
test('429 per-minute is rate_limited; daily quota is quota_exhausted (and not retried)', async () => {
  const a = make([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow down')]);
  assert.equal((await failureOf(a.provider.complete(baseRequest))).failure.category, 'rate_limited');
  const b = make(
    [
      errorBody(429, 'RESOURCE_EXHAUSTED', 'quota', {
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      }),
    ],
    { retry: { maxRetries: 3, ...noSleep } },
  );
  assert.equal((await failureOf(b.provider.complete(baseRequest))).failure.category, 'quota_exhausted');
  assert.equal(b.calls.length, 1);
});

// 9. transient + bounded retry --------------------------------------------------
test('transient errors are retried up to the bound with exponential backoff, then succeed', async () => {
  const sleeps: number[] = [];
  const { provider, calls } = make([errorBody(503, 'UNAVAILABLE', 'busy'), errorBody(500, 'INTERNAL', 'oops'), okText('ok')], {
    retry: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 1000, jitter: (ms) => ms, sleep: async (ms) => void sleeps.push(ms) },
  });
  const res = await provider.complete(baseRequest);
  assert.equal(res.text, 'ok');
  assert.equal(res.meta?.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test('retries are bounded: gives up after maxRetries and surfaces the last failure', async () => {
  const { provider, calls } = make([errorBody(503, 'UNAVAILABLE', 'busy')], { retry: { maxRetries: 2, ...noSleep } });
  const { failure } = await failureOf(provider.complete(baseRequest));
  assert.equal(failure.category, 'transient');
  assert.equal(failure.attempts, undefined);
  assert.equal(calls.length, 3);
});

test('Retry-After is honoured as a floor on the delay; an excessive Retry-After fails fast', async () => {
  const sleeps: number[] = [];
  const a = make([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow', {}, { 'retry-after': '2' }), okText('ok')], {
    retry: { maxRetries: 1, initialDelayMs: 10, jitter: (ms) => ms, sleep: async (ms) => void sleeps.push(ms) },
  });
  await a.provider.complete(baseRequest);
  assert.deepEqual(sleeps, [2000]);

  const b = make([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow', {}, { 'retry-after': '120' })], { retry: { maxRetries: 3, ...noSleep } });
  const { failure } = await failureOf(b.provider.complete(baseRequest));
  assert.equal(failure.retryAfterMs, 120_000);
  assert.equal(b.calls.length, 1, 'must not sleep 120s or retry');
});

test('RetryInfo.retryDelay from the error body is honoured', async () => {
  const sleeps: number[] = [];
  const { provider } = make(
    [
      errorBody(429, 'RESOURCE_EXHAUSTED', 'slow', {
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }],
      }),
      okText('ok'),
    ],
    {
      retry: { maxRetries: 1, initialDelayMs: 10, jitter: (ms) => ms, sleep: async (ms) => void sleeps.push(ms) },
    },
  );
  await provider.complete(baseRequest);
  assert.deepEqual(sleeps, [3000]);
});

test('network failure is transient and retried', async () => {
  const { provider, calls } = make([new TypeError('fetch failed'), okText('ok')], { retry: { maxRetries: 1, ...noSleep } });
  assert.equal((await provider.complete(baseRequest)).text, 'ok');
  assert.equal(calls.length, 2);
});

// 10. timeout + abort -----------------------------------------------------------
test('a hung request times out, is classified timeout, and retries when allowed', async () => {
  const a = make([hangUntilAborted], { timeoutMs: 20 });
  const { failure, error } = await failureOf(a.provider.complete(baseRequest));
  assert.equal(failure.category, 'timeout');
  assert.ok(error.message.includes('may still complete'), 'must not claim remote cancellation');

  const b = make([hangUntilAborted, okText('ok')], { timeoutMs: 20, retry: { maxRetries: 1, ...noSleep } });
  assert.equal((await b.provider.complete(baseRequest)).meta?.attempts, 2);
});

test('caller abort mid-flight is classified aborted and never retried', async () => {
  const ac = new AbortController();
  const { provider, calls } = make([hangUntilAborted, okText('ok')], { timeoutMs: 5000, retry: { maxRetries: 3, ...noSleep } });
  const pending = failureOf(provider.complete({ ...baseRequest, signal: ac.signal }));
  setTimeout(() => ac.abort(), 10);
  assert.equal((await pending).failure.category, 'aborted');
  assert.equal(calls.length, 1);
});

test('an already-aborted signal never reaches the network', async () => {
  const ac = new AbortController();
  ac.abort();
  const { provider, calls } = make([okText('x')]);
  assert.equal((await failureOf(provider.complete({ ...baseRequest, signal: ac.signal }))).failure.category, 'aborted');
  assert.equal(calls.length, 0);
});

// 11. retries disabled ----------------------------------------------------------
test('maxRetries: 0 disables retries entirely', async () => {
  const { provider, calls } = make([errorBody(503, 'UNAVAILABLE', 'busy'), okText('ok')], { retry: { maxRetries: 0 } });
  await failureOf(provider.complete(baseRequest));
  assert.equal(calls.length, 1);
});

// 12. unknown model / pre-network validation -----------------------------------
test('invalid requests are rejected before any network call', async () => {
  const bad: [Partial<ProviderRequest>, string][] = [
    [{ model: 'gpt-4o' }, 'unsupported_model'],
    [{ model: '../../etc' }, 'unsupported_model'],
    [{ maxOutputTokens: 0 }, 'invalid_request'],
    [{ maxOutputTokens: 1_000_000 }, 'invalid_request'],
    [{ temperature: 5 }, 'invalid_request'],
    [{ temperature: Number.NaN }, 'invalid_request'],
    [{ messages: [] }, 'invalid_request'],
    [{ messages: [{ role: 'system', content: 'only system' }] }, 'invalid_request'],
  ];
  for (const [patch, category] of bad) {
    const { provider, calls } = make([okText('x')]);
    assert.equal((await failureOf(provider.complete({ ...baseRequest, ...patch }))).failure.category, category, JSON.stringify(patch));
    assert.equal(calls.length, 0);
  }
  const { provider, calls } = make([okText('x')], { maxInputChars: 10 });
  assert.equal((await failureOf(provider.complete(baseRequest))).failure.category, 'invalid_request');
  assert.equal(calls.length, 0);
});

test('constructor validates its own configuration', () => {
  assert.throws(() => new GeminiProvider({ apiKey: '  ' }), /non-empty apiKey/);
  assert.throws(() => new GeminiProvider({ apiKey: 'k', retry: { maxRetries: 9 } }), /maxRetries/);
  assert.throws(() => new GeminiProvider({ apiKey: 'k', baseUrl: 'http://evil.example.com' }), /https/);
  assert.throws(() => new GeminiProvider({ apiKey: 'k', baseUrl: 'https://u:p@x.example.com' }), /credentials/);
  assert.throws(() => new GeminiProvider({ apiKey: 'k', timeoutMs: 0 }), /timeoutMs/);
  assert.doesNotThrow(() => new GeminiProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9999' }));
});

test('capabilities are declared honestly (no streaming/vision claimed) and default model is Flash-family', () => {
  const caps = make([]).provider.describeCapabilities();
  assert.equal(caps.supportsStreaming, false);
  assert.equal(caps.supportsVision, false);
  assert.equal(caps.supportsStructuredOutput, true);
  assert.ok(caps.models.includes(GEMINI_DEFAULT_MODEL));
  assert.match(GEMINI_DEFAULT_MODEL, /flash/);
  assert.equal(caps.features?.hiddenReasoningTokens, true);
});

// 13. redaction -----------------------------------------------------------------
test('secrets echoed by the vendor or by a network error are redacted from errors and context', async () => {
  const echo = make([errorBody(400, 'INVALID_ARGUMENT', `bad request for key ${TEST_API_KEY} and x-goog-api-key: ${TEST_API_KEY}`)]);
  const a = await failureOf(echo.provider.complete(baseRequest));
  assert.ok(!JSON.stringify((a.error as unknown as { toJSON(): unknown }).toJSON()).includes(TEST_API_KEY));
  assert.ok(!a.error.message.includes(TEST_API_KEY));

  const net = make([new TypeError(`connect failed for https://x/?key=${TEST_API_KEY}`)]);
  const b = await failureOf(net.provider.complete(baseRequest));
  assert.ok(!String((b.error.cause as Error).message).includes(TEST_API_KEY));
});

// 14. no raw prompt/response logging --------------------------------------------
test('telemetry is structured, low-sensitivity, and never contains prompts, responses or the key', async () => {
  const { logger, records } = capturingLogger();
  const ok = make([okText('RESPONSE-CONTENT-SENTINEL')], { logger });
  await ok.provider.complete({ ...baseRequest, requestId: 'req-ok' });
  const bad = make([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow')], { logger, retry: { maxRetries: 0 } });
  await failureOf(bad.provider.complete({ ...baseRequest, requestId: 'req-bad' }));

  const dump = JSON.stringify(records);
  for (const forbidden of ['PROMPT-CONTENT-SENTINEL', 'RESPONSE-CONTENT-SENTINEL', TEST_API_KEY, 'You are an extractor']) {
    assert.ok(!dump.includes(forbidden), `log leaked: ${forbidden}`);
  }
  const done = records.find((r) => r.message === 'inference.request.completed')!;
  assert.equal(done.fields['provider'], 'gemini');
  assert.equal(done.fields['model'], MODEL);
  assert.equal(done.fields['requestId'], 'req-ok');
  assert.equal(done.fields['outcome'], 'success');
  assert.equal(done.fields['retryCount'], 0);
  assert.equal(typeof done.fields['durationMs'], 'number');
  const failed = records.find((r) => r.message === 'inference.request.failed')!;
  assert.equal(failed.fields['category'], 'rate_limited');
  assert.equal(failed.fields['rateLimited'], true);
  assert.equal(failed.fields['timedOut'], false);
  assert.equal(failed.fields['httpStatus'], 429);
});

test('a hostile vendor status string is never logged or embedded; only enum-like tokens survive', async () => {
  const { logger, records } = capturingLogger();
  for (const code of [`LEAK_${TEST_API_KEY}`, 'has spaces and \n newline', 'X'.repeat(200)]) {
    const { provider } = make([errorBody(400, code, 'bad')], { logger });
    const { failure, error } = await failureOf(provider.complete(baseRequest));
    assert.equal(failure.providerCode, undefined);
    assert.ok(!error.message.includes(TEST_API_KEY) && !error.message.includes('newline'));
  }
  assert.ok(!JSON.stringify(records).includes(TEST_API_KEY));
  const ok = make([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow')]);
  assert.equal((await failureOf(ok.provider.complete(baseRequest))).failure.providerCode, 'RESOURCE_EXHAUSTED');
});

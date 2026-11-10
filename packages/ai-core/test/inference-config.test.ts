import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '@xo/errors';
import {
  createProviderFromConfig,
  describeInferenceConfig,
  describeInferenceReadiness,
  resolveInference,
  resolveInferenceConfig,
  type GeminiInferenceConfig,
} from '../src/inference-config.js';
import { GEMINI_DEFAULT_MODEL } from '../src/providers/gemini-provider.js';
import { redactSecrets } from '../src/redaction.js';
import { TEST_API_KEY } from './providers/gemini-helpers.js';

const gemini = { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: TEST_API_KEY };

// 1. registration + explicit selection ------------------------------------------
test('no provider selected => explicitly unconfigured; nothing is silently chosen', () => {
  assert.deepEqual(resolveInferenceConfig({}), { provider: 'none', environment: 'development' });
  assert.equal(resolveInference({}).state, 'unconfigured');
  // A key alone must NOT select a provider.
  assert.equal(resolveInference({ GEMINI_API_KEY: TEST_API_KEY }).state, 'unconfigured');
});

test('explicit selection resolves exactly one provider and a single-provider policy (no fallback chain)', () => {
  const r = resolveInference(gemini);
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  assert.equal(r.provider.id, 'gemini');
  assert.equal(r.config.model, GEMINI_DEFAULT_MODEL);
  assert.deepEqual(r.policy.rules, [{ capability: '*', providerOrder: ['gemini'], modelByProvider: { gemini: GEMINI_DEFAULT_MODEL } }]);
});

// 12. unknown provider fails closed ----------------------------------------------
test('unknown provider fails closed with an actionable error', () => {
  for (const bad of ['openai', 'GEMINI', 'gemini ', 'anthropic']) {
    assert.throws(
      () => resolveInferenceConfig({ XO_INFERENCE_PROVIDER: bad, GEMINI_API_KEY: TEST_API_KEY }),
      (e: unknown) => e instanceof ConfigError && /must be one of \[none, gemini\]/.test(e.message),
    );
  }
});

// 2. validation + missing key -----------------------------------------------------
test('missing or malformed API key and bad model/limits are rejected with actionable messages', () => {
  assert.throws(
    () => resolveInferenceConfig({ XO_INFERENCE_PROVIDER: 'gemini' }),
    /GEMINI_API_KEY is not set.*aistudio\.google\.com\/apikey/s,
  );
  assert.throws(() => resolveInferenceConfig({ XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: '   ' }), /GEMINI_API_KEY is not set/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, GEMINI_API_KEY: 'abc def' }), /whitespace/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_GEMINI_MODEL: 'gpt-4o' }), /XO_GEMINI_MODEL/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_GEMINI_TIMEOUT_MS: '5' }), />= 1000/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_GEMINI_MAX_RETRIES: '99' }), /<= 5/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_GEMINI_TEMPERATURE: '9' }), /<= 2/);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_GEMINI_MAX_OUTPUT_TOKENS: 'lots' }), /must be a number/);
});

test('the missing-key error never contains a key value', () => {
  try {
    resolveInferenceConfig({ XO_INFERENCE_PROVIDER: 'gemini', XO_GEMINI_MODEL: 'nope' });
  } catch (e) {
    assert.ok(!String((e as Error).message).includes(TEST_API_KEY));
  }
});

test('environments: test defaults to no retries; production requires the data-use acknowledgement', () => {
  const dev = resolveInferenceConfig(gemini) as GeminiInferenceConfig;
  const test_ = resolveInferenceConfig({ ...gemini, XO_ENV: 'test' }) as GeminiInferenceConfig;
  assert.equal(dev.maxRetries, 2);
  assert.equal(test_.maxRetries, 0);
  assert.equal((resolveInferenceConfig({ ...gemini, XO_ENV: 'test', XO_GEMINI_MAX_RETRIES: '1' }) as GeminiInferenceConfig).maxRetries, 1);
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_ENV: 'production' }), /XO_GEMINI_ACK_DATA_USE_TERMS=true/);
  assert.equal(resolveInferenceConfig({ ...gemini, XO_ENV: 'production', XO_GEMINI_ACK_DATA_USE_TERMS: 'true' }).provider, 'gemini');
  assert.throws(() => resolveInferenceConfig({ ...gemini, XO_ENV: 'staging' }), /one of \[development, test, production\]/);
  // The acknowledgement is not needed when inference is off.
  assert.equal(resolveInferenceConfig({ XO_ENV: 'production' }).provider, 'none');
});

test('model, timeout, tokens and temperature are configurable and flow into the provider policy', () => {
  const r = resolveInference({
    ...gemini,
    XO_GEMINI_MODEL: 'gemini-3.8-flash',
    XO_GEMINI_TIMEOUT_MS: '5000',
    XO_GEMINI_MAX_OUTPUT_TOKENS: '2048',
    XO_GEMINI_TEMPERATURE: '0.3',
  });
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  assert.deepEqual(
    { m: r.config.model, t: r.config.timeoutMs, o: r.config.maxOutputTokens, temp: r.config.temperature },
    { m: 'gemini-3.8-flash', t: 5000, o: 2048, temp: 0.3 },
  );
  assert.deepEqual(r.provider.describeCapabilities().models, [GEMINI_DEFAULT_MODEL, 'gemini-3.8-flash']);
});

// 13. secret redaction ------------------------------------------------------------
test('the credential cannot leak through JSON, spread, or the describe helper', () => {
  const config = resolveInferenceConfig(gemini) as GeminiInferenceConfig;
  assert.equal(config.apiKey, TEST_API_KEY); // still usable by the one consumer that needs it
  assert.ok(!JSON.stringify(config).includes(TEST_API_KEY));
  assert.ok(!JSON.stringify({ ...config }).includes(TEST_API_KEY));
  assert.ok(!JSON.stringify(describeInferenceConfig(config)).includes(TEST_API_KEY));
});

test('redactSecrets scrubs exact secrets, Google-key-shaped strings and auth headers', () => {
  const out = redactSecrets(
    `k=${TEST_API_KEY} other AIzaSyABCDEFGHIJKLMNOPQRSTUV and x-goog-api-key: hunter2hunter2 Authorization=Bearer`,
    [TEST_API_KEY],
  );
  assert.ok(!out.includes(TEST_API_KEY) && !out.includes('AIzaSyABCDEF') && !out.includes('hunter2'));
  assert.equal(redactSecrets('nothing to see'), 'nothing to see');
});

// readiness ------------------------------------------------------------------------
test('readiness distinguishes configured from reachable/verified, never calls the vendor and never exposes the key', () => {
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    const configured = describeInferenceReadiness(gemini);
    assert.deepEqual(configured, {
      state: 'configured',
      provider: 'gemini',
      model: GEMINI_DEFAULT_MODEL,
      environment: 'development',
      providerReachable: 'not_checked',
      inferenceVerified: false,
    });
    assert.equal(describeInferenceReadiness({}).state, 'unconfigured');
    const invalid = describeInferenceReadiness({ XO_INFERENCE_PROVIDER: 'gemini' });
    assert.equal(invalid.state, 'invalid');
    assert.match(invalid.problem ?? '', /GEMINI_API_KEY/);
    assert.ok(!JSON.stringify(configured).includes(TEST_API_KEY));
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('createProviderFromConfig only builds providers it knows', () => {
  const config = resolveInferenceConfig(gemini) as GeminiInferenceConfig;
  assert.equal(createProviderFromConfig(config).id, 'gemini');
  assert.throws(
    () => createProviderFromConfig({ ...config, provider: 'mystery' } as unknown as GeminiInferenceConfig),
    /Unknown inference provider/,
  );
});

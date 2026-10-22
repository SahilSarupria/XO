import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_PROVIDER_HEADERS, resolveProvider } from '../src/routes/runtime/provider-factory.js';
import type { ApiRequest } from '../src/http/types.js';

const fakeRequest = (headers: Record<string, string | string[]> = {}): ApiRequest => ({ headers }) as unknown as ApiRequest;
const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmno';
const gemini = { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: KEY };

test('there is NO implicit default provider: unconfigured server => refusal (not anthropic)', () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa', GEMINI_API_KEY: KEY }]) {
    const result = resolveProvider(fakeRequest(), env);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not configured on this server/);
  }
});

test('server configuration is authoritative: XO_INFERENCE_PROVIDER selects the provider', () => {
  const result = resolveProvider(fakeRequest(), gemini);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'gemini');
});

test('invalid server configuration surfaces an actionable error without secrets', () => {
  const unknown = resolveProvider(fakeRequest(), { XO_INFERENCE_PROVIDER: 'openai', GEMINI_API_KEY: KEY });
  assert.equal(unknown.ok, false);
  const noKey = resolveProvider(fakeRequest(), { XO_INFERENCE_PROVIDER: 'gemini' });
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /GEMINI_API_KEY/);
});

test('every client-supplied provider header is rejected, even when it matches or when server config is valid', () => {
  for (const name of CLIENT_PROVIDER_HEADERS) {
    const result = resolveProvider(fakeRequest({ [name]: 'anything' }), gemini);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.ok(result.error.includes(name), name);
      assert.ok(!result.error.includes('anything'), 'must not echo the supplied value (it may be a credential)');
    }
  }
});

test('a client-supplied key can never override the server credential or select another provider', () => {
  const result = resolveProvider(
    fakeRequest({ 'x-xo-provider': 'anthropic', 'x-xo-api-key': 'attacker-key', 'x-xo-base-url': 'https://evil.example.com' }),
    gemini,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!result.error.includes('attacker-key') && !result.error.includes('evil.example.com'));
  }
});

test('header rejection happens BEFORE any server-config/credential resolution', () => {
  // Server config is invalid (gemini, no key). If credential resolution ran first we would see the config error instead.
  const result = resolveProvider(fakeRequest({ 'x-xo-api-key': 'attacker-key' }), { XO_INFERENCE_PROVIDER: 'gemini' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /controlled by the server/);
    assert.ok(!/GEMINI_API_KEY/.test(result.error));
  }
});

test('XO_INFERENCE_PROVIDER=none disables inference even when every provider key is present', () => {
  const result = resolveProvider(fakeRequest(), {
    XO_INFERENCE_PROVIDER: 'none',
    GEMINI_API_KEY: KEY,
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oa',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not configured on this server/);
});

test('configuration errors never echo the server credential, even a malformed one', () => {
  const result = resolveProvider(fakeRequest(), { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: `${KEY} trailing` });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(!result.error.includes(KEY) && !result.error.includes('trailing'));
});

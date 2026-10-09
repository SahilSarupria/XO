import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import type { ApiRequest } from '../src/http/types.js';
import { resolveProvider } from '../src/routes/runtime/provider-factory.js';

function fakeRequest(headers: IncomingHttpHeaders): ApiRequest {
  return {
    method: 'POST',
    path: '/runtime/execute',
    params: {},
    query: new URLSearchParams(),
    headers,
    rawBody: async () => Buffer.alloc(0),
    json: async () => ({ ok: false, error: new Error('not used') }) as never,
  };
}

test('defaults to anthropic when no x-xo-provider header is present', () => {
  const result = resolveProvider(fakeRequest({}), { ANTHROPIC_API_KEY: 'test-key' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'anthropic');
});

test('rejects an unsupported provider id', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': 'not-real' }), {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unknown provider/);
});

test('an explicit x-xo-api-key header wins over the environment variable', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': 'anthropic', 'x-xo-api-key': 'from-header' }), { ANTHROPIC_API_KEY: 'from-env' });
  assert.equal(result.ok, true);
});

test('falls back to the env var when no header is present', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': 'openai' }), { OPENAI_API_KEY: 'from-env' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'openai');
});

test('fails cleanly when neither header nor env var supplies a required API key', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': 'gemini' }), {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /GEMINI_API_KEY/);
});

test('azure-openai requires both an API key and an endpoint', () => {
  const missingEndpoint = resolveProvider(fakeRequest({ 'x-xo-provider': 'azure-openai', 'x-xo-api-key': 'key' }), {});
  assert.equal(missingEndpoint.ok, false);
  if (!missingEndpoint.ok) assert.match(missingEndpoint.error, /endpoint/);

  const both = resolveProvider(fakeRequest({ 'x-xo-provider': 'azure-openai', 'x-xo-api-key': 'key', 'x-xo-endpoint': 'https://example.openai.azure.com' }), {});
  assert.equal(both.ok, true);
});

test('ollama needs neither a header nor an env var', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': 'ollama' }), {});
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'ollama');
});

test('a repeated header (array value from node:http) uses the first value', () => {
  const result = resolveProvider(fakeRequest({ 'x-xo-provider': ['openai', 'anthropic'], 'x-xo-api-key': 'k' }), {});
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'openai');
});

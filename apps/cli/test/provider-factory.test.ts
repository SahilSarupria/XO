import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../src/commands/runtime/provider-factory.js';

test('resolveProvider defaults to anthropic and reads ANTHROPIC_API_KEY from env', () => {
  const result = resolveProvider({}, { ANTHROPIC_API_KEY: 'sk-test-123' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'anthropic');
});

test('resolveProvider fails clearly when anthropic has no key anywhere', () => {
  const result = resolveProvider({ provider: 'anthropic' }, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /ANTHROPIC_API_KEY/);
});

test('an explicit --api-key wins over the environment variable', () => {
  const result = resolveProvider({ provider: 'anthropic', apiKey: 'flag-key' }, { ANTHROPIC_API_KEY: 'env-key' });
  assert.equal(result.ok, true);
});

test('resolveProvider constructs openai from OPENAI_API_KEY', () => {
  const result = resolveProvider({ provider: 'openai' }, { OPENAI_API_KEY: 'sk-oa-1' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'openai');
});

test('azure-openai requires both an API key and an endpoint', () => {
  const missingEndpoint = resolveProvider({ provider: 'azure-openai' }, { AZURE_OPENAI_API_KEY: 'k' });
  assert.equal(missingEndpoint.ok, false);
  if (!missingEndpoint.ok) assert.match(missingEndpoint.error, /endpoint/);

  const ok = resolveProvider(
    { provider: 'azure-openai' },
    { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com' },
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.id, 'azure-openai');
});

test('resolveProvider constructs gemini from GEMINI_API_KEY', () => {
  const result = resolveProvider({ provider: 'gemini' }, { GEMINI_API_KEY: 'g-1' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'gemini');
});

test('ollama needs no API key at all', () => {
  const result = resolveProvider({ provider: 'ollama' }, {});
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.id, 'ollama');
});

test('an unknown --provider value fails with the list of supported ids', () => {
  const result = resolveProvider({ provider: 'not-a-real-provider' }, {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unknown --provider/);
    assert.match(result.error, /anthropic/);
    assert.match(result.error, /ollama/);
  }
});

test('XO_INFERENCE_PROVIDER selects the provider when --provider is absent; an explicit --provider wins', () => {
  const viaEnv = resolveProvider({}, { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key-123456', ANTHROPIC_API_KEY: 'a' });
  assert.equal(viaEnv.ok && viaEnv.value.id, 'gemini');
  const flagWins = resolveProvider(
    { provider: 'anthropic' },
    { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' },
  );
  assert.equal(flagWins.ok && flagWins.value.id, 'anthropic');
});

test('XO_INFERENCE_PROVIDER=none disables inference unless --provider is explicit', () => {
  const disabled = resolveProvider({}, { XO_INFERENCE_PROVIDER: 'none', ANTHROPIC_API_KEY: 'a' });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.match(disabled.error, /disabled/);
  const explicit = resolveProvider({ provider: 'anthropic' }, { XO_INFERENCE_PROVIDER: 'none', ANTHROPIC_API_KEY: 'a' });
  assert.equal(explicit.ok, true);
});

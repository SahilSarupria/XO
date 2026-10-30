import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveOperatorProvider, validateEndpoint } from '../src/commands/layer/operator-provider.js';

describe('operator provider (env-only configuration)', () => {
  it('requires XO_MODEL and an API key from the environment, and exposes no secret flags', () => {
    assert.equal(resolveOperatorProvider({}).ok, false);
    const noKey = resolveOperatorProvider({ XO_MODEL: 'm' });
    assert.ok(!noKey.ok && /API key/i.test(noKey.error));
    const good = resolveOperatorProvider({ XO_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'k' });
    assert.ok(good.ok);
    assert.equal(good.ok && good.value.providerId, 'anthropic');
    assert.equal(good.ok && good.value.model, 'claude-sonnet-5-5');
  });
  it('rejects unknown providers', () => {
    const r = resolveOperatorProvider({ XO_MODEL: 'm', XO_PROVIDER: 'nope' });
    assert.ok(!r.ok && /unknown/.test(r.error));
  });
  it('endpoint allowlist: https only (loopback may be http), no credentials, known hosts unless the operator opts out', () => {
    const env = {};
    assert.ok(validateEndpoint('https://api.anthropic.com', env).ok);
    assert.ok(validateEndpoint('http://localhost:11434', env).ok);
    assert.ok(validateEndpoint('https://my-res.openai.azure.com', env).ok);
    assert.ok(!validateEndpoint('http://api.anthropic.com', env).ok);
    assert.ok(!validateEndpoint('https://user:pw@api.anthropic.com', env).ok);
    assert.ok(!validateEndpoint('https://169.254.169.254/latest', env).ok); // cloud metadata endpoint
    assert.ok(!validateEndpoint('https://evil.example.com', env).ok);
    assert.ok(validateEndpoint('https://llm.corp.internal', { XO_ALLOW_CUSTOM_ENDPOINT: '1' }).ok);
    assert.ok(!validateEndpoint('not a url', env).ok);
    const viaEnv = resolveOperatorProvider({ XO_MODEL: 'm', ANTHROPIC_API_KEY: 'k', XO_PROVIDER_BASE_URL: 'https://evil.example.com' });
    assert.ok(!viaEnv.ok);
  });
});

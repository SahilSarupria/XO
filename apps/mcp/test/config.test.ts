import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ConfigError, DEFAULT_REQUEST_TIMEOUT_MS, loadConfig } from '../src/config.js';

const KEY = 'xoak_0123456789abcdefghijklmnopqrstuvwxyz';
const ok = { XO_API_KEY: KEY, XO_API_URL: 'http://127.0.0.1:8080', XO_WORKSPACE_ID: 'ws_1' };

test('config: the credential comes from the environment only; missing key fails closed without naming any value', () => {
  assert.throws(
    () => loadConfig({ ...ok, XO_API_KEY: undefined }),
    (e: unknown) => e instanceof ConfigError && /XO_API_KEY is required/.test(e.message),
  );
  assert.throws(() => loadConfig({ ...ok, XO_API_KEY: '' }), ConfigError);
  assert.throws(
    () => loadConfig({ ...ok, XO_API_KEY: 'has space in it' }),
    (e: unknown) => e instanceof ConfigError && !e.message.includes('has space'),
  );
  assert.throws(() => loadConfig({ ...ok, XO_API_KEY: 'short' }), ConfigError);
  assert.throws(() => loadConfig({ ...ok, XO_API_KEY: `${KEY}\nX-Evil: 1` }), ConfigError);
});

test('config: URL and workspace are required and validated; plain http only for loopback; no embedded credentials or paths', () => {
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: undefined }), /XO_API_URL is required/);
  assert.throws(() => loadConfig({ ...ok, XO_WORKSPACE_ID: undefined }), /XO_WORKSPACE_ID is required/);
  assert.throws(() => loadConfig({ ...ok, XO_WORKSPACE_ID: '../x' }), /malformed/);
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: 'http://example.com' }), /https/);
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: 'ftp://127.0.0.1' }), /http\(s\)/);
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: 'https://user:pw@example.com' }), /credentials/);
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: 'https://example.com/api?x=1' }), /origin only/);
  assert.throws(() => loadConfig({ ...ok, XO_API_URL: 'not a url' }), /valid URL/);
  assert.equal(loadConfig({ ...ok, XO_API_URL: 'https://xo.example.com/' }).apiBaseUrl, 'https://xo.example.com');
  assert.equal(loadConfig(ok).apiBaseUrl, 'http://127.0.0.1:8080');
});

test('config: timeout is bounded; default is conservative', () => {
  assert.equal(loadConfig(ok).requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(loadConfig({ ...ok, XO_MCP_REQUEST_TIMEOUT_MS: '5000' }).requestTimeoutMs, 5000);
  for (const bad of ['0', '999', '900001', '1e3', '-5', 'abc']) {
    assert.throws(() => loadConfig({ ...ok, XO_MCP_REQUEST_TIMEOUT_MS: bad }), /XO_MCP_REQUEST_TIMEOUT_MS/);
  }
});

test('config: the credential is not visible through JSON, inspect or spread', () => {
  const c = loadConfig(ok);
  assert.equal(c.apiKey, KEY);
  assert.equal(JSON.stringify(c).includes(KEY), false);
  assert.equal(inspect(c).includes(KEY), false);
  assert.equal(JSON.stringify({ ...c }).includes(KEY), false);
});

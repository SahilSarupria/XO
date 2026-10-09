import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, describeConfig } from '../src/config-loader.js';
import type { ConfigSchema } from '../src/schema.js';

const schema = {
  logLevel: { type: 'enum', values: ['debug', 'info', 'warn'] as const, default: 'info' },
  port: { type: 'number', default: 8080, min: 1, max: 65535 },
  featureXEnabled: { type: 'boolean', default: false },
  apiKey: { type: 'string', required: false },
} as const satisfies ConfigSchema;

test('loadConfig applies defaults when env vars are absent', () => {
  const config = loadConfig(schema, { env: {} });
  assert.equal(config.logLevel, 'info');
  assert.equal(config.port, 8080);
  assert.equal(config.featureXEnabled, false);
});

test('loadConfig reads and coerces values from env', () => {
  const config = loadConfig(schema, {
    env: { XO_LOG_LEVEL: 'debug', XO_PORT: '3000', XO_FEATURE_X_ENABLED: 'true' },
  });
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.port, 3000);
  assert.equal(config.featureXEnabled, true);
});

test('loadConfig throws ConfigError on an out-of-range number', () => {
  assert.throws(() => loadConfig(schema, { env: { XO_PORT: '999999' } }), /must be <= 65535/);
});

test('loadConfig throws ConfigError on an invalid enum value', () => {
  assert.throws(() => loadConfig(schema, { env: { XO_LOG_LEVEL: 'verbose' } }), /must be one of/);
});

test('loadConfig throws on a missing required key', () => {
  const requiredSchema = { apiKey: { type: 'string', required: true } } as const satisfies ConfigSchema;
  assert.throws(() => loadConfig(requiredSchema, { env: {} }), /Missing required config key/);
});

test('describeConfig masks secret-looking keys', () => {
  const config = loadConfig(schema, { env: { XO_API_KEY: 'super-secret' } });
  const rendered = describeConfig(schema, config);
  assert.match(rendered, /XO_API_KEY=\*{8}/);
  assert.match(rendered, /XO_PORT=8080/);
});

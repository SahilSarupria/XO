import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityInputSchema } from '@xo/types';
import type { ExternalToolAdapter } from '@xo/adapters';
import { loadConfig, parseExternalEffectsDir } from '../src/config.js';
import { createConfiguredExternalToolWiring } from '../src/external-tools-host.js';

// P1.1 M4 — the evidence location comes from the supported server configuration path (XO_EXTERNAL_EFFECTS_DIR) and nowhere else.
// The shipped entrypoint enables no adapters; an embedding host that supplies adapters builds its wiring through this helper.

const SCHEMA: CapabilityInputSchema = { type: 'object', properties: {}, required: [] };
const adapter: ExternalToolAdapter = { id: 'a', invoke: async () => ({ kind: 'confirmed_success', output: 1 }) };
const options = { adapters: new Map([['cap', adapter]]), inputSchemas: new Map([['cap', SCHEMA]]) };

test('config: XO_EXTERNAL_EFFECTS_DIR has no default; unset/blank means not configured; control characters abort', () => {
  assert.equal(loadConfig({}).externalEffectsDir, undefined);
  assert.equal(loadConfig({ XO_EXTERNAL_EFFECTS_DIR: '   ' }).externalEffectsDir, undefined);
  assert.equal(loadConfig({ XO_EXTERNAL_EFFECTS_DIR: ' /var/lib/xo/effects ' }).externalEffectsDir, '/var/lib/xo/effects');
  assert.throws(() => parseExternalEffectsDir('/x\u0000y'), /plain directory path/);
  assert.throws(() => loadConfig({ XO_EXTERNAL_EFFECTS_DIR: 'a\nb' }), /plain directory path/);
});

test('config: with no evidence directory configured, external-tool wiring cannot be built (fails closed before any dispatch)', () => {
  assert.throws(() => createConfiguredExternalToolWiring(loadConfig({}), options), /XO_EXTERNAL_EFFECTS_DIR/);
});

test('config: with a directory configured, wiring is durable and evidence lands in that directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-effects-cfg-'));
  try {
    const wiring = createConfiguredExternalToolWiring(loadConfig({ XO_EXTERNAL_EFFECTS_DIR: dir }), options);
    assert.equal(wiring.ledgerDurability, 'durable');
    assert.ok(wiring.describe('cap'), 'the configured adapter is described (adapter id, schema, config digest)');
    assert.equal(typeof wiring.describe('cap')?.configDigest, 'string');
    assert.deepEqual(await wiring.evidenceFor('nothing:yet'), []);
    assert.equal(wiring.describe('other'), undefined, 'nothing else is configured');
    assert.deepEqual(await readdir(dir), [], 'merely reading creates no evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

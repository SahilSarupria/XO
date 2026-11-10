import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@xo/errors';
import { createCompilerAiLayer } from '../src/inference-config.js';
import { getInferenceDenial } from '../src/inference-policy.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import { TEST_API_KEY, okText, scriptedFetch } from './providers/gemini-helpers.js';

const gemini = { XO_INFERENCE_PROVIDER: 'gemini', GEMINI_API_KEY: TEST_API_KEY };
const req: CapabilityRequest<EntityExtractionInput> = { input: {}, excerpt: { text: 'hello', documentPath: 'a.pdf' }, traceId: 't' };

test('no provider selected: unconfigured (compile stays rule-based); limits are not even required', () => {
  assert.deepEqual(createCompilerAiLayer({}), { state: 'unconfigured' });
});

test('a provider without a compile spend limit is a CONFIG ERROR, not an unlimited compile', () => {
  assert.throws(
    () => createCompilerAiLayer(gemini),
    (e: unknown) => e instanceof ConfigError && /spend limit/.test(e.message),
  );
});

test('with a limit: a bounded layer, allowUnboundedInference false', () => {
  const r = createCompilerAiLayer({ ...gemini, XO_COMPILER_MAX_TOTAL_TOKENS: '100000' });
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  assert.equal(r.aiCore.inferenceBounded(), true);
  assert.equal(r.allowUnboundedInference, false);
});

test('explicit operator opt-in: layer is unbounded and the flag to forward is true', () => {
  const r = createCompilerAiLayer({ ...gemini, XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE: 'true' });
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  assert.equal(r.aiCore.inferenceBounded(), false);
  assert.equal(r.allowUnboundedInference, true);
});

test('end to end: limit enforced, durable cache wired from XO_INFERENCE_CACHE_DIR, no key on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-factory-'));
  try {
    const f = scriptedFetch([okText('{"entities":[]}', { promptTokenCount: 30, candidatesTokenCount: 5, totalTokenCount: 35 })]);
    const r = createCompilerAiLayer(
      { ...gemini, XO_COMPILER_MAX_TOTAL_TOKENS: '100000', XO_INFERENCE_CACHE_DIR: dir },
      { fetchImpl: f.fetchImpl },
    );
    assert.equal(r.state, 'configured');
    if (r.state !== 'configured') return;
    assert.ok((await r.aiCore.extractEntities(req)).ok);
    const second = await r.aiCore.extractEntities(req);
    assert.ok(second.ok && second.value.meta.cacheHit);
    assert.equal(f.calls.length, 1);
    assert.equal(r.aiCore.inferenceReport().spend?.tokensSpent, 35);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(!f.calls[0]!.rawBody.includes(TEST_API_KEY));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a token limit of 0 forbids all compile-time inference', async () => {
  const f = scriptedFetch([okText('{"entities":[]}')]);
  const r = createCompilerAiLayer({ ...gemini, XO_COMPILER_MAX_TOTAL_TOKENS: '0' }, { fetchImpl: f.fetchImpl });
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  const out = await r.aiCore.extractEntities(req);
  assert.equal(out.ok, false);
  assert.equal(f.calls.length, 0);
  if (!out.ok) assert.equal(getInferenceDenial(out.error)?.reason, 'budget_exhausted');
});

test('a cost cap with the default (unpriced) Gemini model is refused as cost_unestimable, not run at $0', async () => {
  const f = scriptedFetch([okText('{"entities":[]}')]);
  const r = createCompilerAiLayer({ ...gemini, XO_COMPILER_MAX_COST_USD: '1' }, { fetchImpl: f.fetchImpl });
  assert.equal(r.state, 'configured');
  if (r.state !== 'configured') return;
  const out = await r.aiCore.extractEntities(req);
  assert.equal(out.ok, false);
  assert.equal(f.calls.length, 0);
  if (!out.ok) assert.equal(getInferenceDenial(out.error)?.reason, 'cost_unestimable');
});

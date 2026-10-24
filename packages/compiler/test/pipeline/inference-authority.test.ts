import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AiCapabilityLayer, InferenceGuard, ScriptableTestProvider, type ServerInferencePolicy } from '@xo/ai-core';
import { ErrorCode } from '@xo/errors';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { compilePdfToXoir } from '../../src/pipeline/from-pdf.js';
import { compilePdfToPackage } from '../../src/pipeline/compile-pdf-to-package.js';
import { checkCompileInferenceAuthority } from '../../src/pipeline/inference-authority.js';

function layer(policy: Partial<ServerInferencePolicy> | 'no-scope') {
  const provider = new ScriptableTestProvider('anthropic', []);
  const aiCore = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'test-model' } }] },
    ...(policy === 'no-scope'
      ? {}
      : { inferenceScope: new InferenceGuard({ enabled: true, allowUndeclared: false, ...policy }).beginRun() }),
  });
  return { aiCore, provider };
}
const sourceInput = async () => {
  const text = await readFile(new URL('../../../../examples/vertical-test/openapi-operation-data-flow.json', import.meta.url), 'utf8');
  return [{ kind: 'openapi', text, sourcePath: 'openapi-operation-data-flow.json' }];
};

test('compileSources REFUSES an AI layer with no inference scope, before doing any work', async () => {
  const { aiCore, provider } = layer('no-scope');
  const r = await compileSources(await sourceInput(), { aiCore });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, ErrorCode.CONFIG_MISSING_KEY);
    assert.match(r.error.message, /no spend limit/);
  }
  assert.equal(provider.callLog.length, 0);
});

test('a scope built from an UNLIMITED policy is still refused (it measures, it does not bound)', async () => {
  const { aiCore } = layer({});
  const r = await compileSources(await sourceInput(), { aiCore });
  assert.equal(r.ok, false);
});

test('explicit allowUnboundedInference lets an unbounded layer through, and says so in the log', async () => {
  const { aiCore } = layer('no-scope');
  const warnings: string[] = [];
  const logger = {
    level: 'trace' as const,
    trace() {},
    debug() {},
    info() {},
    warn: (m: string) => void warnings.push(m),
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  const r = await compileSources(await sourceInput(), { aiCore, allowUnboundedInference: true, logger });
  assert.equal(r.ok, true);
  assert.ok(warnings.some((m) => /UNBOUNDED/.test(m)));
});

test('a bounded layer (finite limit) or a disabled-inference layer is accepted without any opt-in', async () => {
  assert.equal((await compileSources(await sourceInput(), { aiCore: layer({ maxTotalTokens: 1000 }).aiCore })).ok, true);
  assert.equal((await compileSources(await sourceInput(), { aiCore: layer({ enabled: false }).aiCore })).ok, true);
});

test('no aiCore at all: rule-based compile is unchanged and unchecked', async () => {
  assert.equal((await compileSources(await sourceInput(), {})).ok, true);
});

test('compilePdfToXoir and compilePdfToPackage check authority BEFORE touching the input', async () => {
  const { aiCore } = layer('no-scope');
  const garbage = new Uint8Array([1, 2, 3]);
  const a = await compilePdfToXoir(garbage, 'x.pdf', { aiCore });
  assert.equal(!a.ok && a.error.code, ErrorCode.CONFIG_MISSING_KEY, 'refused for the missing limit, not a PDF parse error');
  const b = await compilePdfToPackage(garbage, 'x.pdf', { aiCore, identity: {} as never });
  assert.equal(!b.ok && b.error.code, ErrorCode.CONFIG_MISSING_KEY);
});

test('checkCompileInferenceAuthority unit semantics', () => {
  const bounded = { inferenceBounded: () => true };
  const unbounded = { inferenceBounded: () => false };
  assert.equal(checkCompileInferenceAuthority(undefined, undefined).ok, true);
  assert.equal(checkCompileInferenceAuthority(bounded, undefined).ok, true);
  assert.equal(checkCompileInferenceAuthority(unbounded, undefined).ok, false);
  assert.equal(checkCompileInferenceAuthority(unbounded, false).ok, false);
  assert.equal(checkCompileInferenceAuthority(unbounded, true).ok, true);
});

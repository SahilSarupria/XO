import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, ErrorCode } from '@xo/errors';
import { assertValidModelSelectionPolicy, validateModelSelectionPolicy, type PolicyIssueCode } from '../src/policy-validation.js';
import { singleProviderPolicy } from '../src/inference-config.js';
import { AiCapabilityLayer } from '../src/router.js';
import { ScriptableTestProvider, jsonResponse } from '../src/providers/scriptable-test-provider.js';
import type { ProviderCapabilityDescriptor, ProviderId } from '../src/provider-types.js';

const rule = (over: Record<string, unknown> = {}) => ({
  capability: '*',
  providerOrder: ['anthropic'],
  modelByProvider: { anthropic: 'claude-sonnet-4-6' },
  ...over,
});
const policy = (over: Record<string, unknown> = {}, rules: unknown[] = [rule()]) => ({ rules, ...over });
const codes = (p: unknown, ctx = {}, severity?: 'error' | 'warning'): PolicyIssueCode[] =>
  validateModelSelectionPolicy(p, ctx)
    .issues.filter((i) => severity === undefined || i.severity === severity)
    .map((i) => i.code);
const descriptor = (id: string, structured = true): ProviderCapabilityDescriptor => ({
  providerId: id,
  models: [],
  supportsStreaming: false,
  supportsStructuredOutput: structured,
  supportsVision: false,
  maxContextTokens: 1,
});
const registry = (...entries: [string, boolean?][]): Map<ProviderId, ProviderCapabilityDescriptor> =>
  new Map(entries.map(([id, structured]) => [id, descriptor(id, structured ?? true)]));

// valid policies stay valid ---------------------------------------------------------------------
test('valid policies are accepted with no issues (wildcard, per-capability, fallback chain, allowFallback)', () => {
  assert.deepEqual(validateModelSelectionPolicy(policy()).issues, []);
  assert.deepEqual(validateModelSelectionPolicy(singleProviderPolicy('gemini', 'gemini-3.5-flash-lite')).issues, []);
  const chain = policy({ allowFallback: true }, [
    rule({ capability: 'extractEntities', providerOrder: ['a', 'b'], modelByProvider: { a: 'm1', b: 'm2' } }),
    rule(),
  ]);
  assert.deepEqual(validateModelSelectionPolicy(chain).issues, []);
  assert.equal(validateModelSelectionPolicy(chain).ok, true);
});

test('every policy shape used elsewhere in the existing test-suite stays valid', () => {
  assert.equal(
    validateModelSelectionPolicy({ rules: [{ capability: '*', providerOrder: ['p1', 'p2'], modelByProvider: { p1: 'm1', p2: 'm2' } }] }).ok,
    true,
  );
  assert.equal(
    validateModelSelectionPolicy({ rules: [] }).ok,
    true,
    'an empty policy is legal (it is a warning), as router.test.ts relies on',
  );
});

// structural errors -----------------------------------------------------------------------------
test('non-object policy / non-array rules / non-object rule are errors', () => {
  for (const bad of [null, undefined, 'x', 42, [], () => 1]) assert.deepEqual(codes(bad), ['policy_not_object']);
  assert.deepEqual(codes({ rules: 'x' }), ['rules_not_array']);
  assert.deepEqual(codes({ rules: [null] }, {}, 'error'), ['rule_not_object']);
  assert.deepEqual(codes({ rules: [[]] }, {}, 'error'), ['rule_not_object']);
});

test('unknown keys are errors: a misspelt allowFallback would otherwise silently keep failover ON', () => {
  assert.deepEqual(codes({ rules: [rule()], allowFallbak: false }, {}, 'error'), ['unknown_key']);
  assert.deepEqual(codes(policy({}, [rule({ providerOrders: ['x'] })]), {}, 'error').sort(), ['unknown_key']);
});

test('allowFallback must be a boolean', () => {
  for (const bad of ['false', 0, null, {}])
    assert.deepEqual(codes(policy({ allowFallback: bad }), {}, 'error'), ['allow_fallback_invalid']);
  assert.equal(validateModelSelectionPolicy(policy({ allowFallback: undefined })).ok, true);
});

test('capability must be "*" or a real capability id; duplicates are errors', () => {
  assert.deepEqual(codes(policy({}, [rule({ capability: 'extractEntites' })]), {}, 'error'), ['capability_invalid']);
  assert.deepEqual(codes(policy({}, [rule({ capability: 7 })]), {}, 'error'), ['capability_invalid']);
  assert.deepEqual(codes(policy({}, [rule(), rule()]), {}, 'error'), ['capability_duplicate']);
  assert.deepEqual(codes(policy({}, [rule({ capability: 'extractEntities' }), rule({ capability: 'extractEntities' })]), {}, 'error'), [
    'capability_duplicate',
  ]);
});

test('providerOrder: must be a non-empty array of clean unique ids', () => {
  assert.deepEqual(codes(policy({}, [rule({ providerOrder: 'anthropic' })]), {}, 'error'), ['provider_order_invalid']);
  assert.ok(codes(policy({}, [rule({ providerOrder: [] })]), {}, 'error').includes('provider_order_empty'));
  for (const bad of ['', ' ', 'a b', 'a\nb', 'x'.repeat(129), 7, null]) {
    assert.ok(
      codes(policy({}, [rule({ providerOrder: [bad], modelByProvider: {} })]), {}, 'error').includes('provider_id_invalid'),
      String(bad),
    );
  }
  assert.ok(
    codes(policy({}, [rule({ providerOrder: ['a', 'a'], modelByProvider: { a: 'm' } })]), {}, 'error').includes('provider_duplicate'),
  );
});

test('modelByProvider: every listed provider needs its own clean model; inherited keys do not count', () => {
  assert.deepEqual(codes(policy({}, [rule({ modelByProvider: {} })]), {}, 'error'), ['model_missing']);
  assert.deepEqual(codes(policy({}, [rule({ modelByProvider: 'x' })]), {}, 'error'), ['model_map_invalid']);
  for (const bad of ['', ' ', 'a b', 'm\u0000', 'x'.repeat(201), 5, null]) {
    assert.deepEqual(codes(policy({}, [rule({ modelByProvider: { anthropic: bad } })]), {}, 'error'), ['model_invalid'], String(bad));
  }
  // `toString`/`constructor` exist on every object: without an own-property check they would pass as "has a model".
  for (const id of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.deepEqual(codes(policy({}, [rule({ providerOrder: [id], modelByProvider: {} })]), {}, 'error'), ['model_missing'], id);
  }
});

test('every error is reported at once, with a path', () => {
  const result = validateModelSelectionPolicy({
    rules: [rule({ capability: 'nope', providerOrder: [], modelByProvider: 3 }), 5],
    allowFallback: 'x',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5);
  assert.ok(result.errors.every((e) => e.path.length > 0 && e.message.length > 0));
});

test('messages never echo long or hostile values', () => {
  const hostile = 'sk-ant-SECRET'.repeat(50);
  const result = validateModelSelectionPolicy(policy({}, [rule({ providerOrder: [hostile], modelByProvider: { [hostile]: hostile } })]));
  for (const issue of result.issues) assert.ok(issue.message.length < 600 && issue.path.length < 200, issue.message.slice(0, 80));
  assert.ok(!JSON.stringify(result.issues).includes(hostile));
});

// warnings -----------------------------------------------------------------------------------------
test('warnings do not invalidate: empty rules, uncovered capabilities, unreferenced models', () => {
  assert.deepEqual(codes({ rules: [] }), ['rules_empty']);
  const partial = validateModelSelectionPolicy(policy({}, [rule({ capability: 'extractEntities' })]));
  assert.equal(partial.ok, true);
  assert.deepEqual(
    partial.warnings.map((w) => w.code),
    ['capability_uncovered'],
  );
  assert.ok(partial.warnings[0]!.message.includes('extractKnowledge'));
  const typo = validateModelSelectionPolicy(policy({}, [rule({ modelByProvider: { anthropic: 'm', antropic: 'm2' } })]));
  assert.equal(typo.ok, true);
  assert.deepEqual(
    typo.warnings.map((w) => w.code),
    ['model_unreferenced'],
  );
});

test('registry-aware warnings (never errors): unregistered, not structured-output, no eligible provider', () => {
  const p = policy({}, [
    rule({ providerOrder: ['gemini', 'ollama', 'anthropic'], modelByProvider: { gemini: 'g', ollama: 'o', anthropic: 'a' } }),
  ]);
  const ctx = { providers: registry(['ollama', false], ['anthropic']), requireStructuredOutput: true };
  const result = validateModelSelectionPolicy(p, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((w) => w.code).sort(), ['provider_not_structured_output', 'provider_unregistered']);

  const none = validateModelSelectionPolicy(p, { providers: registry(), requireStructuredOutput: true });
  assert.equal(none.ok, true);
  assert.ok(none.warnings.some((w) => w.code === 'rule_no_eligible_provider'));

  const withoutRegistry = validateModelSelectionPolicy(p);
  assert.deepEqual(withoutRegistry.issues, [], 'registry checks only run when a registry is supplied');
});

// assert + router integration ------------------------------------------------------------------------
test('assertValidModelSelectionPolicy throws ConfigError(CONFIG_INVALID_VALUE) listing every error, else returns warnings', () => {
  assert.throws(
    () => assertValidModelSelectionPolicy(policy({}, [rule({ modelByProvider: {} })])),
    (e: unknown) =>
      e instanceof ConfigError && e.code === ErrorCode.CONFIG_INVALID_VALUE && /rules\[0\]\.modelByProvider\.anthropic/.test(e.message),
  );
  const ok = assertValidModelSelectionPolicy({ rules: [] });
  assert.equal(ok.result.warnings.length, 1);
});

test('AiCapabilityLayer refuses an invalid policy at construction, and exposes warnings for a legal-but-suspicious one', () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse({ entities: [] }) }]);
  assert.throws(
    () =>
      new AiCapabilityLayer({ providers: [provider], policy: { rules: [rule({ providerOrder: ['anthropic', 'anthropic'] })] } as never }),
    (e: unknown) => e instanceof ConfigError,
  );
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [rule({ providerOrder: ['gemini', 'anthropic'], modelByProvider: { gemini: 'g', anthropic: 'claude-sonnet-4-6' } })] },
  });
  assert.deepEqual(
    layer.policyWarnings.map((w) => w.code),
    ['provider_unregistered'],
  );
});

test('a layer built with the existing empty-policy / no-provider configuration still constructs and answers AI_NO_ELIGIBLE_PROVIDER', async () => {
  const layer = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const res = await layer.extractEntities({ input: {}, excerpt: { text: 't', documentPath: 'a.pdf' }, traceId: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, ErrorCode.AI_NO_ELIGIBLE_PROVIDER);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { ConversationLayer } from '../src/conversation.js';
import { ScriptableTestProvider, jsonResponse } from '../src/providers/scriptable-test-provider.js';
import type { JsonSchema } from '../src/json-schema.js';
import type { ProviderResponse } from '../src/provider-types.js';

const fast = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };
const text = (t: string, finishReason: ProviderResponse['finishReason'] = 'stop'): ProviderResponse => ({
  text: t,
  usage: { inputTokens: 5, outputTokens: 7 },
  modelUsed: 'test-model',
  finishReason,
});
const messages = [{ role: 'user' as const, content: 'hi' }];
const schema: JsonSchema = { type: 'object', properties: { intent: { type: 'string', enum: ['ask', 'do'] } }, required: ['intent'] };

test('converse returns trimmed text with provider/model/cost metadata', async () => {
  const p = new ScriptableTestProvider('a', [{ kind: 'success', response: text('  hello  ') }]);
  const layer = new ConversationLayer({ providers: [p], retryOptions: fast });
  const r = await layer.converse({ task: 'conversation.answer', messages, traceId: 't', candidates: [{ providerId: 'a', model: 'm' }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.output, 'hello');
  assert.equal(r.value.meta.providerUsed, 'a');
  assert.equal(r.value.meta.attempts, 1);
  assert.equal(r.value.meta.candidatesTried, 1);
  assert.equal(p.callLog[0]?.model, 'm', 'the explicit candidate model is what reaches the provider');
});

test('converseStructured validates against the schema and sends it to the provider', async () => {
  const p = new ScriptableTestProvider('a', [{ kind: 'success', response: jsonResponse({ intent: 'ask' }) }]);
  const layer = new ConversationLayer({ providers: [p], retryOptions: fast });
  const r = await layer.converseStructured<{ intent: string }>({
    task: 'conversation.route',
    messages,
    traceId: 't',
    responseSchema: schema,
    candidates: [{ providerId: 'a', model: 'm' }],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.output, { intent: 'ask' });
  assert.deepEqual(p.callLog[0]?.responseSchema, schema);
});

test('accepts JSON wrapped in a Markdown fence, but not arbitrary prose', async () => {
  const fenced = new ScriptableTestProvider('a', [{ kind: 'success', response: text('```json\n{"intent":"do"}\n```') }]);
  const ok1 = await new ConversationLayer({ providers: [fenced], retryOptions: fast }).converseStructured({
    task: 'conversation.route',
    messages,
    traceId: 't',
    responseSchema: schema,
    candidates: [{ providerId: 'a', model: 'm' }],
  });
  assert.ok(ok1.ok);

  const prose = new ScriptableTestProvider('a', [{ kind: 'success', response: text('Sure! The intent is ask.') }]);
  const bad = await new ConversationLayer({ providers: [prose], retryOptions: fast }).converseStructured({
    task: 'conversation.route',
    messages,
    traceId: 't',
    responseSchema: schema,
    candidates: [{ providerId: 'a', model: 'm' }],
  });
  assert.ok(!bad.ok);
});

test('a reply that parses but violates the schema is a failed attempt, and the next provider is used', async () => {
  const wrong = new ScriptableTestProvider('a', [{ kind: 'success', response: jsonResponse({ intent: 'dance' }) }]);
  const right = new ScriptableTestProvider('b', [{ kind: 'success', response: jsonResponse({ intent: 'do' }) }]);
  const layer = new ConversationLayer({ providers: [wrong, right], retryOptions: fast });
  const r = await layer.converseStructured<{ intent: string }>({
    task: 'conversation.route',
    messages,
    traceId: 't',
    responseSchema: schema,
    candidates: [
      { providerId: 'a', model: 'm1' },
      { providerId: 'b', model: 'm2' },
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.meta.providerUsed, 'b');
  assert.equal(r.value.meta.candidatesTried, 2);
  assert.equal(wrong.callLog.length, 2, 'the failing provider was retried once before falling back');
});

test('an empty or content-filtered reply is a failure, not an empty answer', async () => {
  const blocked = new ScriptableTestProvider('a', [{ kind: 'success', response: text('', 'content_filter') }]);
  const backup = new ScriptableTestProvider('b', [{ kind: 'success', response: text('fine') }]);
  const r = await new ConversationLayer({ providers: [blocked, backup], retryOptions: fast }).converse({
    task: 'conversation.answer',
    messages,
    traceId: 't',
    candidates: [
      { providerId: 'a', model: 'm' },
      { providerId: 'b', model: 'm' },
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.output, 'fine');
});

test('all providers failing yields AI_ALL_PROVIDERS_FAILED without leaking provider error text', async () => {
  const p = new ScriptableTestProvider('a', [{ kind: 'failure', error: new Error('secret-request-id-123 key=sk-abc') }]);
  const r = await new ConversationLayer({ providers: [p], retryOptions: fast }).converse({
    task: 'conversation.answer',
    messages,
    traceId: 't',
    candidates: [{ providerId: 'a', model: 'm' }],
  });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
  assert.doesNotMatch(r.error.message, /secret-request-id|sk-abc/);
});

test('no candidates and no policy rule is AI_NO_ELIGIBLE_PROVIDER; unknown providers are skipped', async () => {
  const layer = new ConversationLayer({ providers: [], retryOptions: fast });
  const none = await layer.converse({ task: 'conversation.answer', messages, traceId: 't' });
  assert.ok(!none.ok);
  if (!none.ok) assert.equal(none.error.code, ErrorCode.AI_NO_ELIGIBLE_PROVIDER);
  const unknown = await layer.converse({
    task: 'conversation.answer',
    messages,
    traceId: 't',
    candidates: [{ providerId: 'ghost', model: 'm' }],
  });
  assert.ok(!unknown.ok);
});

test('the model-selection policy routes conversation tasks independently', async () => {
  const small = new ScriptableTestProvider('small', [{ kind: 'success', response: jsonResponse({ intent: 'ask' }) }]);
  const big = new ScriptableTestProvider('big', [{ kind: 'success', response: text('long answer') }]);
  const layer = new ConversationLayer({
    providers: [small, big],
    retryOptions: fast,
    policy: {
      rules: [
        { capability: 'conversation.route', providerOrder: ['small'], modelByProvider: { small: 's' } },
        { capability: 'conversation.answer', providerOrder: ['big'], modelByProvider: { big: 'b' } },
      ],
    },
  });
  const route = await layer.converseStructured({ task: 'conversation.route', messages, traceId: 't', responseSchema: schema });
  const answer = await layer.converse({ task: 'conversation.answer', messages, traceId: 't' });
  assert.ok(route.ok && answer.ok);
  assert.equal(small.callLog.length, 1);
  assert.equal(big.callLog.length, 1);
});

test('lazily resolved providers are used and cached by id', async () => {
  const p = new ScriptableTestProvider('lazy', [
    { kind: 'success', response: text('one') },
    { kind: 'success', response: text('two') },
  ]);
  let resolves = 0;
  const layer = new ConversationLayer({ retryOptions: fast, resolveProvider: (id) => (id === 'lazy' ? (resolves++, p) : undefined) });
  for (let i = 0; i < 2; i++) {
    const r = await layer.converse({
      task: 'conversation.answer',
      messages,
      traceId: 't',
      candidates: [{ providerId: 'lazy', model: 'm' }],
    });
    assert.ok(r.ok);
  }
  assert.equal(resolves, 1);
});

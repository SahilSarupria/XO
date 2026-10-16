import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { NonProductionAuditSink, SYSTEM_ACTOR } from '@xo/audit';
import { AiCapabilityLayer } from '../src/router.js';
import { ScriptableTestProvider, jsonResponse } from '../src/providers/scriptable-test-provider.js';
import type { ModelSelectionPolicy } from '../src/model-selection.js';

// P1.0 M4 — restricted audit data can never be sent to a model provider.

const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['p'], modelByProvider: { p: 'm' } }] };
const retry = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };

test('audit data in the excerpt or input is refused before any provider call', async () => {
  const sink = new NonProductionAuditSink();
  const appended = await sink.append({ type: 'access.attempted', action: 'read.x', outcome: 'attempted', actor: SYSTEM_ACTOR });
  assert.ok(appended.ok);
  if (!appended.ok) return;
  const provider = new ScriptableTestProvider('p', [{ kind: 'success', response: jsonResponse({ entities: [] }) }]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy, retryOptions: retry });

  const viaExcerpt = await layer.extractEntities({
    input: {},
    excerpt: { text: JSON.stringify(appended.event), documentPath: 'a', page: 1 },
    traceId: 't1',
  });
  assert.equal(viaExcerpt.ok, false);
  if (!viaExcerpt.ok) assert.equal(viaExcerpt.error.code, ErrorCode.AUDIT_ACCESS_DENIED);
  const viaInput = await layer.extractEntities({
    input: { event: appended.event } as never,
    excerpt: { text: 'ok', documentPath: 'a', page: 1 },
    traceId: 't2',
  });
  assert.equal(viaInput.ok, false);
  assert.equal(provider.callLog.length, 0, 'the provider was never called');

  const ordinary = await layer.extractEntities({
    input: {},
    excerpt: { text: 'ordinary contract text', documentPath: 'a', page: 1 },
    traceId: 't3',
  });
  assert.ok(ordinary.ok);
  assert.equal(provider.callLog.length, 1);
});

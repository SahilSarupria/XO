/**
 * RX-1c (ADR 0048), mandatory scenario 14 through the API: connector rate limits from the settings registry, a provider's "slow down"
 * honoured with a bounded pause, and the step deadline (a call that would wait past it fails without being sent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExternalToolResult } from '@xo/adapters';
import { parseConnectorRateLimits } from '../src/workflow-controls/connector-rate-limits.js';
import { env, items, type RunView } from './payments-fixture.js';
import { TestServer } from './test-helpers.js';

const ok = (n: number) => ({ kind: 'confirmed_success', output: { paymentId: `pay_${n}` } }) as ExternalToolResult;
const slowDown = (ms: number) =>
  ({ kind: 'confirmed_failure_no_effect', code: 'rate_limited', message: '429', retryAfterMs: ms }) as ExternalToolResult;

test('the setting is parsed strictly; an invalid value stops start-up', async () => {
  assert.deepEqual(parseConnectorRateLimits('mail=2/5, *=20'), {
    limits: { mail: { perSecond: 2, burst: 5 } },
    fallback: { perSecond: 20 },
  });
  assert.deepEqual(parseConnectorRateLimits(undefined), { limits: {} });
  for (const bad of ['mail', 'mail=0', 'mail=fast', 'mail=2/0', 'm ail=2'])
    assert.throws(() => parseConnectorRateLimits(bad), /XO_CONNECTOR_RATE_LIMITS/);
  await assert.rejects(TestServer.start({ env: { XO_CONNECTOR_RATE_LIMITS: 'payments=fast' } }), /XO_CONNECTOR_RATE_LIMITS/);
});

test('Scenario 14: calls to a limited connector are spaced at its rate across a batch; each item is sent once', async () => {
  await env(
    async ({ server, pay, ws, defId, certId }) => {
      const at: number[] = [];
      pay.behave((n) => (at.push(Date.now()), ok(n)));
      const r = await server.request('POST', `/workspaces/${ws}/generated-workflows/${defId}/runs`, {
        input: { payment_items: items(8) },
        certificateId: certId,
      });
      assert.equal(r.json<RunView>().state, 'completed', r.bodyText);
      assert.equal(pay.calls.length, 8);
      assert.equal(new Set(pay.calls.map((c) => c.account)).size, 8);
      // 20 per second with a burst of 1: eight calls take at least seven gaps of 50 ms (a little slack for timer rounding).
      assert.ok(at.at(-1)! - at[0]! >= 7 * 50 * 0.9, `spread ${at.at(-1)! - at[0]!} ms`);
    },
    { env: { XO_CONNECTOR_RATE_LIMITS: 'payments=20/1' } },
  );
});

test('Scenario 14: a provider "slow down" pauses that connector for the time it asked and the call is made again; nothing twice', async () => {
  await env(async ({ server, pay, ws, defId, certId }) => {
    const at: number[] = [];
    let refused = false;
    pay.behave((n) => {
      at.push(Date.now());
      if (n === 3 && !refused) {
        refused = true;
        return slowDown(250);
      }
      return ok(n);
    });
    const r = await server.request('POST', `/workspaces/${ws}/generated-workflows/${defId}/runs`, {
      input: { payment_items: items(5) },
      certificateId: certId,
    });
    assert.equal(r.json<RunView>().state, 'completed', r.bodyText);
    assert.equal(pay.calls.length, 6, 'five sends and the one refused attempt');
    assert.equal(new Set(pay.calls.map((c) => c.account)).size, 5);
    assert.ok(Math.max(...at) - at[2]! >= 240, 'the next call waited the pause the provider asked for');
  });
});

test('Scenario 14: a pause longer than the step deadline fails the call RATE_LIMITED, provably not sent; no call starts after the pause began', async () => {
  await env(
    async ({ server, pay, ws, defId, certId }) => {
      const at: number[] = [];
      let pausedAt = 0;
      pay.behave((n) => {
        at.push(Date.now());
        if (n === 2) {
          pausedAt = Date.now();
          return slowDown(120_000);
        }
        return ok(n);
      });
      const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
      const r = await server.request('POST', runs, { input: { payment_items: items(12) }, certificateId: certId });
      const batch = r.json<RunView>();
      assert.notEqual(batch.state, 'completed', r.bodyText);
      // Items already holding a slot when the provider answered may still go; none starts after the pause began.
      assert.ok(pay.calls.length < 12, `${pay.calls.length} calls`);
      assert.ok(
        at.every((t) => t <= pausedAt + 100),
        'no call was started after the provider asked to pause',
      );
      const outcomes = (batch.outputs as { items: { runId: string; state: string }[] }).items;
      assert.ok(outcomes.filter((i) => i.state !== 'completed').length >= 12 - pay.calls.length + 1);
      for (const it of outcomes.filter((i) => i.state !== 'completed')) {
        const v = (await server.request('GET', `${runs}/${it.runId}`)).json<RunView>();
        assert.ok(
          v.effects.every((e) => e.state !== 'outcome_unknown'),
          `item ${it.runId}: ${JSON.stringify(v.effects)} (a refused or unsent call is never "maybe sent")`,
        );
      }
    },
    { env: { XO_CONNECTOR_RATE_LIMITS: 'payments=1000/1' } },
  );
});

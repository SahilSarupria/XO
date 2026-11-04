import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvalAbortedError, isTransportError, runEval, type Arm } from '../src/index.js';
import { generateEvalTasks } from '../src/index.js';

const deadArm: Arm = {
  id: 'plain',
  run: async () => ({
    output: null,
    rawText: '',
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
    path: 'model',
    overridden: false,
    latencyMs: 1,
    error: 'Gemini API returned 404: model retired',
  }),
} as unknown as Arm;

describe('dead endpoints are not scored as wrong answers', () => {
  it('aborts after a streak of transport failures', async () => {
    const tasks = generateEvalTasks().slice(0, 30);
    await assert.rejects(runEval({ arms: [deadArm], tasks, concurrency: 2, abortAfterConsecutiveTransportErrors: 5 }), EvalAbortedError);
  });
  it('does not treat an unparseable reply as transport failure', () => {
    assert.equal(
      isTransportError({ run: { error: 'no JSON object in reply', path: 'model', inputTokens: 10, outputTokens: 3 } } as never),
      false,
    );
  });
});

import { PacedProvider, RetryingProvider, isExhaustedQuota, retryAfterSeconds } from '../src/index.js';

describe('quota handling', () => {
  const ok = { text: '{}', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' as const };
  it('parses the server-suggested delay and waits for it', async () => {
    assert.equal(retryAfterSeconds('429 ... Please retry in 12.5s.'), 12.5);
    const waits: number[] = [];
    let n = 0;
    const p = new RetryingProvider(
      {
        id: 'x',
        describeCapabilities: () => ({}) as never,
        complete: async () => {
          if (n++ < 1) throw new Error('Gemini API returned 429: "retryDelay": "7s"');
          return ok;
        },
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    await p.complete({ model: 'm', maxOutputTokens: 1, messages: [] });
    assert.deepEqual(waits, [7500]);
  });
  it('does not retry a per-day / billing quota', async () => {
    const msg = 'Gemini API returned 429: Quota exceeded for metric generate_content_free_tier_requests PerDay; retryDelay 30s';
    assert.equal(isExhaustedQuota(msg), true);
    let calls = 0;
    const p = new RetryingProvider(
      { id: 'x', describeCapabilities: () => ({}) as never, complete: async () => (calls++, Promise.reject(new Error(msg))) },
      { sleep: async () => undefined },
    );
    await assert.rejects(p.complete({ model: 'm', maxOutputTokens: 1, messages: [] }), /QUOTA EXHAUSTED/);
    assert.equal(calls, 1);
  });
  it('retries a per-minute 429 that merely mentions billing', () => {
    assert.equal(isExhaustedQuota('429 You exceeded your current quota, check your plan and billing details. PerMinute'), false);
  });
  it('spaces calls by 60000/rpm', async () => {
    const stamps: number[] = [];
    const p = new PacedProvider(
      { id: 'x', describeCapabilities: () => ({}) as never, complete: async () => (stamps.push(Date.now()), ok) },
      600, // 100ms apart
    );
    await Promise.all([1, 2, 3].map(() => p.complete({ model: 'm', maxOutputTokens: 1, messages: [] })));
    assert.ok(stamps[2]! - stamps[0]! >= 190, `gaps ${stamps}`);
  });
});

import { buildReport, renderMarkdown } from '../src/index.js';

describe('report separates API failures from wrong answers', () => {
  it('flags transport failures and gives the rate excluding them', () => {
    const mk = (pass: boolean, error?: string) =>
      ({
        arm: 'xo_tools',
        taskId: `t${Math.random()}`,
        stratum: 's',
        trial: 1,
        score: { parsed: pass, decisionOk: pass, payoutOk: pass, targetOk: pass, pass, unsafeAutoApproval: false, falseEscalation: false },
        run: {
          output: null,
          rawText: '',
          modelCalls: 1,
          inputTokens: error ? 0 : 5,
          outputTokens: error ? 0 : 5,
          toolCalls: [],
          path: 'model',
          overridden: false,
          latencyMs: 1,
          ...(error ? { error } : {}),
        },
      }) as never;
    const recs = [mk(true), mk(true), mk(true), mk(false, 'Gemini API returned 503')];
    const md = renderMarkdown(buildReport(recs, { model: 'm', provider: 'p', date: 'd', trials: 1, selfTest: false }));
    assert.match(md, /1 of 4 runs failed at the API/);
    assert.match(md, /100% \(3\/3\)/);
  });
});

import { RetryingProvider, waitMeter } from '../src/index.js';
import type { ModelProvider as MP } from '@xo/ai-core';

it('retry waiting is metered per request and capped, so a stalled API fails instead of taking minutes', async () => {
  const flaky: MP = {
    id: 'flaky',
    describeCapabilities: () => ({
      providerId: 'flaky',
      models: ['m'],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: false,
      maxContextTokens: 1,
    }),
    complete: async () => {
      throw new Error('503 overloaded');
    },
  };
  const slept: number[] = [];
  const p = new RetryingProvider(flaky, { attempts: 8, baseDelayMs: 1000, maxTotalWaitMs: 5000, sleep: async (ms) => void slept.push(ms) });
  const stats = { retryMs: 0, pacedMs: 0, retries: 0 };
  await assert.rejects(
    waitMeter.run(stats, () => p.complete({ model: 'm', messages: [] } as never)),
    /gave up after/,
  );
  assert.ok(stats.retries >= 1 && stats.retryMs <= 5000);
  assert.equal(
    slept.reduce((a, b) => a + b, 0),
    stats.retryMs,
  );
});

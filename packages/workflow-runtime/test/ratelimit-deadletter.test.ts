import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError } from '@xo/connectors';
import { FileDeadLetterStore, MemoryDeadLetterStore, RateLimiters } from '../src/index.js';
import { comp, decide, external, harness, pay } from './support.js';

describe('token bucket', () => {
  it('allows a burst, then spaces callers out in order', () => {
    let t = 1_000;
    const rl = new RateLimiters({ bank: { perSecond: 2, burst: 2 } }, () => t);
    assert.equal(rl.reserve('bank').waitMs, 0);
    assert.equal(rl.reserve('bank').waitMs, 0);
    assert.equal(rl.reserve('bank').waitMs, 500); // third caller waits for one token at 2/s
    assert.equal(rl.reserve('bank').waitMs, 1000); // fourth queues behind it
    t += 1000; // refill never exceeds the burst
    assert.equal(rl.reserve('bank').waitMs, 500);
  });
  it('a cancelled reservation returns its token; an unlimited key is never delayed; a backwards clock refills nothing', () => {
    let t = 10_000;
    const rl = new RateLimiters({ a: { perSecond: 1, burst: 1 } }, () => t);
    rl.reserve('a');
    const second = rl.reserve('a');
    assert.equal(second.waitMs, 1000);
    second.cancel();
    second.cancel(); // idempotent: cannot mint extra tokens
    assert.equal(rl.reserve('a').waitMs, 1000);
    assert.equal(rl.reserve('other').waitMs, 0);
    assert.equal(rl.has('other'), false);
    t = 0;
    assert.ok(rl.reserve('a').waitMs >= 1000);
  });
  it('rejects nonsense configuration instead of disabling the limit', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      assert.throws(() => new RateLimiters({ a: { perSecond: bad } }), /perSecond/);
    assert.throws(() => new RateLimiters({ a: { perSecond: 1, burst: 0 } }), /burst/);
    assert.throws(() => new RateLimiters({ a: { perSecond: 1, burst: 1.5 } }), /burst/);
  });
});

describe('runner: rate limiting', () => {
  it('waits for a slot before calling, and journals the call only after the wait', async () => {
    const ext = external();
    const h = await harness(comp([decide(), pay()]));
    const rl = new RateLimiters({ bank: { perSecond: 1, burst: 1 } }, () => 5_000);
    const { runner, sleeps } = h.mk({ rateLimits: rl });
    const a = await runner.start({ inputs: { amount: 10, claim: 'c1' } });
    const b = await runner.start({ inputs: { amount: 11, claim: 'c2' } });
    assert.equal(a.state, 'completed');
    assert.equal(b.state, 'completed');
    assert.deepEqual(sleeps, [1000]); // the second call was told to wait one second (clock frozen by the test)
    assert.equal(h.ext === ext ? 0 : h.ext.effects.length, 2);
  });
  it('a wait beyond the step timeout fails RATE_LIMITED without calling the destination', async () => {
    const h = await harness(comp([decide(), pay({ timeoutMs: 100 })]));
    const rl = new RateLimiters({ bank: { perSecond: 0.01, burst: 1 } }, () => 5_000);
    const { runner } = h.mk({ rateLimits: rl });
    await runner.start({ inputs: { amount: 10, claim: 'c1' } });
    const r = await runner.start({ inputs: { amount: 11, claim: 'c2' } });
    assert.equal(r.state, 'failed');
    assert.equal(h.ext.effects.length, 1);
    assert.equal(h.ext.calls.length, 1); // nothing was sent for the limited run
  });
});

describe('dead letters', () => {
  it('stores an exhausted step AND fails the run; the record carries no arguments', async () => {
    const ext = external({ failFirst: 99 });
    const h = await harness(
      comp([decide(), pay({ retry: { maxAttempts: 2, backoff: { kind: 'fixed', baseMs: 1, maxMs: 1, jitter: 'none' } } })]),
      ext,
    );
    const dl = new MemoryDeadLetterStore();
    const { runner } = h.mk({ deadLetters: dl });
    const r = await runner.start({ inputs: { amount: 10, claim: 'secret-claim-77' } });
    assert.equal(r.state, 'failed');
    const items = await dl.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.step, 'pay');
    assert.equal(items[0]?.disposition, 'failed');
    assert.equal(items[0]?.attempts, 2);
    assert.doesNotMatch(JSON.stringify(items), /secret-claim-77/);
  });
  it('an escalated step is stored too, and recording is idempotent', async () => {
    const h = await harness(comp([{ ...decide(), inputs: { amount: { from: 'input.amount' } } }, pay()]));
    const dl = new MemoryDeadLetterStore();
    const { runner } = h.mk({ deadLetters: dl });
    const r = await runner.start({ inputs: { amount: 5000, claim: 'c' } }); // no rule matches => escalate
    assert.equal(r.state, 'escalated');
    const items = await dl.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.disposition, 'escalated');
    await dl.put({ ...(items[0] as object), id: undefined } as never);
    assert.equal((await dl.list()).length, 1);
  });
  it('a store that cannot persist stops the run instead of dropping the failure', async () => {
    const ext = external({ failFirst: 99 });
    const h = await harness(comp([decide(), pay()]), ext);
    const broken = {
      put: async () => {
        throw new Error('disk full');
      },
      list: async () => [],
    };
    const { runner } = h.mk({ deadLetters: broken });
    await assert.rejects(() => runner.start({ inputs: { amount: 10, claim: 'c' } }), /disk full/);
  });
  it('file store writes one atomic record per failure and refuses to hide a damaged one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-dlq-'));
    const store = new FileDeadLetterStore(dir);
    const base = {
      runId: 'r1',
      workflow: 'wf',
      version: '1',
      step: 's',
      code: 'FAILED',
      message: 'm',
      attempts: 3,
      disposition: 'failed' as const,
      at: 'x',
    };
    const a = await store.put(base);
    await store.put(base);
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, `${a.id}.json`), 'utf8')), a);
    assert.deepEqual(
      (await readdir(dir)).filter((n) => n.endsWith('.tmp')),
      [],
    );
    await import('node:fs/promises').then((f) => f.writeFile(join(dir, `dl_${'0'.repeat(32)}.json`), '{not json'));
    await assert.rejects(() => store.list());
    assert.equal(await new FileDeadLetterStore(join(dir, 'missing')).list().then((l) => l.length), 0);
    void ConnectorError;
  });
});

describe('environment record', () => {
  it('operator decisions (such as an unconfined MCP server) are written into the journal of every run', async () => {
    const h = await harness(comp([decide(), pay()]));
    const env = { mcpConfinement: { srv: { kind: 'none', operatorOptOut: true } } };
    const { runner, store } = h.mk({ environment: env });
    const r = await runner.start({ inputs: { amount: 10, claim: 'c1' } });
    const entries = await store.read(r.runId);
    assert.deepEqual((entries[0]?.data as { environment?: unknown }).environment, env);
    const plain = h.mk({});
    const p = await plain.runner.start({ inputs: { amount: 10, claim: 'c2' } });
    assert.equal('environment' in ((await plain.store.read(p.runId))[0]?.data as object), false);
  });
});

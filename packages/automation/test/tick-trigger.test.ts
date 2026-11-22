/** UW-15 (ADR 0044 amended): a host-driven trigger, and an engine that records outcomes only in its ledger. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationEngine, TickTrigger } from '../src/index.js';

test('TickTrigger: events go through the engine at most once per key; outbox off writes no files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-tick-'));
  try {
    const trigger = new TickTrigger('host');
    const seen: string[] = [];
    const engine = new AutomationEngine({
      dir,
      outbox: false,
      workflows: [
        {
          id: 'w',
          triggers: [trigger],
          run: async (e) => {
            seen.push(e.idempotencyKey);
            return { disposition: 'completed', lane: 'x', summary: 'ok' };
          },
        },
      ],
    });
    assert.deepEqual(await trigger.fire([{ source: 'schedule', idempotencyKey: 'a', receivedAt: 'now', payload: {} }]), [
      { accepted: false, reason: 'stopped' },
    ]);
    await engine.start();
    const ev = (k: string) => ({ source: 'schedule' as const, idempotencyKey: k, receivedAt: 'now', payload: { k } });
    const r = await trigger.fire([ev('a'), ev('a'), ev('b')]);
    assert.deepEqual(
      r.map((x) => [x.accepted, x.duplicate === true]),
      [
        [true, false],
        [false, true],
        [true, false],
      ],
    );
    await engine.idle();
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(await readdir(join(dir, 'outbox')), []);
    await engine.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

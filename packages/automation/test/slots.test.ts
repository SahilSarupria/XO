// UW-15 (ADR 0044): slots, missed-slot policy, leases, and parity with the engine's ScheduleTrigger slot key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLeaseStore, SqliteLeaseStore, missedSlotPlan, slotOf, ScheduleTrigger, type TriggerEvent } from '../src/index.js';

const MIN = 60_000;

test('nothing is missed on time or one slot late', () => {
  for (const policy of ['run_latest', 'skip'] as const) {
    assert.deepEqual(missedSlotPlan({ lastFiredMs: 10 * 30 * MIN, nowMs: 11 * 30 * MIN, everyMs: 30 * MIN, policy }), {
      run: undefined,
      skipped: [],
    });
    assert.deepEqual(missedSlotPlan({ lastFiredMs: 10 * 30 * MIN + 5, nowMs: 11 * 30 * MIN + 29 * MIN, everyMs: 30 * MIN, policy }), {
      run: undefined,
      skipped: [],
    });
    assert.deepEqual(missedSlotPlan({ lastFiredMs: undefined, nowMs: 5, everyMs: 30 * MIN, policy }), { run: undefined, skipped: [] });
  }
});

test('after downtime: run_latest runs only the most recent missed slot and skips the rest; skip runs none', () => {
  const every = 30 * MIN;
  const input = { lastFiredMs: 10 * every + 1, nowMs: 15 * every + 5, everyMs: every };
  assert.deepEqual(missedSlotPlan({ ...input, policy: 'run_latest' }), { run: 14, skipped: [11, 12, 13] });
  assert.deepEqual(missedSlotPlan({ ...input, policy: 'skip' }), { run: undefined, skipped: [11, 12, 13, 14] });
});

test('run_latest only runs the latest missed slot when it is within 24 hours; otherwise all missed are skipped', () => {
  const every = 7 * 24 * 60 * MIN; // weekly
  const p = missedSlotPlan({ lastFiredMs: 2 * every, nowMs: 5 * every - 3 * 86_400_000, everyMs: every, policy: 'run_latest' });
  assert.deepEqual(p, { run: undefined, skipped: [3] }, 'the missed week ended four days ago');
  const q = missedSlotPlan({ lastFiredMs: 2 * every, nowMs: 4 * every + 3_600_000, everyMs: every, policy: 'run_latest' });
  assert.deepEqual(q, { run: 3, skipped: [] }, 'the missed week ended an hour ago');
});

test('a lease is held by one holder, extended by it, taken over after expiry, and fenced; memory and SQLite agree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-lease-'));
  const stores = [new MemoryLeaseStore(), new SqliteLeaseStore(join(dir, 'leases.sqlite'))];
  try {
    for (const s of stores) {
      const a = await s.acquire('scheduler', 'A', 1000, 0);
      assert.equal(a?.fence, 1);
      assert.equal(await s.acquire('scheduler', 'B', 1000, 500), undefined, 'held by A');
      assert.equal((await s.acquire('scheduler', 'A', 1000, 600))?.expiresAtMs, 1600, 'A extends');
      const b = await s.acquire('scheduler', 'B', 1000, 1600);
      assert.equal(b?.holder, 'B', 'expired: B takes over');
      assert.equal(b?.fence, 2, 'a new holder bumps the fence');
      assert.equal(await s.acquire('scheduler', 'A', 1000, 1700), undefined, 'A lost it');
      await s.release('scheduler', 'A'); // not A's: no effect
      assert.equal(await s.acquire('scheduler', 'A', 1000, 1800), undefined);
      await s.release('scheduler', 'B');
      assert.equal((await s.acquire('scheduler', 'A', 1000, 1800))?.holder, 'A', 'released: free');
    }
    // Two connections to one file agree (two processes on one data directory): A holds it, so C is refused.
    const second = new SqliteLeaseStore(join(dir, 'leases.sqlite'));
    assert.equal(await second.acquire('scheduler', 'C', 1000, 1900), undefined);
    assert.equal(
      (await second.acquire('scheduler', 'C', 1000, 3000))?.holder,
      'C',
      'after A expires, C takes it through its own connection',
    );
    second.close();
  } finally {
    (stores[1] as SqliteLeaseStore).close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parity: the API scheduler's idempotency slot is the slot the engine's ScheduleTrigger puts in its key, for the same instants", async () => {
  const everyMinutes = 30;
  const times = [0, 1, 29 * MIN, 30 * MIN, 30 * MIN + 1, 7 * 30 * MIN + 12345, 1_700_000_000_000];
  for (const t of times) {
    const keys: string[] = [];
    const trigger = new ScheduleTrigger('job', { everyMs: everyMinutes * MIN, runOnStart: true, now: () => t });
    await trigger.start(async (ev: TriggerEvent) => {
      keys.push(ev.idempotencyKey);
      return { accepted: true } as never;
    });
    await trigger.stop();
    // apps/api/src/workflow-controls/scheduler.ts: `schedule:${everyMinutes}:${Math.floor(now / (everyMinutes * 60_000))}`
    const apiSlot = Math.floor(t / (everyMinutes * 60_000));
    assert.deepEqual(keys, [`job@${apiSlot}`], `at ${t}`);
    assert.equal(slotOf(t, everyMinutes * MIN), apiSlot);
  }
});

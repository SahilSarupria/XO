import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AutomationEngine,
  FileDropTrigger,
  HashChainLedger,
  PermanentError,
  ScheduleTrigger,
  WebhookTrigger,
  type Emit,
  type Trigger,
  type WorkflowOutcome,
} from '../src/index.js';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'xo-auto-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A trigger the test drives by hand. */
class ManualTrigger implements Trigger {
  emit!: Emit;
  constructor(readonly id = 'manual') {}
  async start(emit: Emit): Promise<void> {
    this.emit = emit;
  }
  async stop(): Promise<void> {}
  fire(key: string, payload: unknown = { key }) {
    return this.emit({ trigger: this.id, source: 'manual', idempotencyKey: key, receivedAt: new Date().toISOString(), payload });
  }
}
const ok = (summary = 'ok', lane = 'decisions'): WorkflowOutcome => ({ disposition: 'completed', summary, lane, output: { summary } });
const noSleep = async (): Promise<void> => undefined;

describe('HashChainLedger', () => {
  it('detects edited, deleted and reordered entries, and refuses to reopen a broken chain', async () => {
    const dir = await tmp();
    const path = join(dir, 'l.jsonl');
    const l = await HashChainLedger.open(path);
    for (let i = 0; i < 5; i++) await l.append('evt', { i });
    assert.equal((await HashChainLedger.verifyFile(path)).ok, true);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');

    await writeFile(path, [lines[0], lines[1]!.replace('"i":1', '"i":99'), ...lines.slice(2)].join('\n') + '\n');
    const edited = await HashChainLedger.verifyFile(path);
    assert.equal(edited.ok, false);
    assert.equal(edited.brokenAt, 2);

    await writeFile(path, [lines[0], lines[2], ...lines.slice(3)].join('\n') + '\n');
    assert.equal((await HashChainLedger.verifyFile(path)).ok, false);
    await assert.rejects(HashChainLedger.open(path), /failed verification/);

    await writeFile(path, lines.join('\n') + '\n');
    const reopened = await HashChainLedger.open(path);
    await reopened.append('evt', { i: 5 });
    assert.equal((await HashChainLedger.verifyFile(path)).entries, 6);
  });
  it('serializes concurrent appends into one valid chain', async () => {
    const dir = await tmp();
    const l = await HashChainLedger.open(join(dir, 'l.jsonl'));
    await Promise.all(Array.from({ length: 50 }, (_, i) => l.append('c', { i })));
    assert.equal((await HashChainLedger.verifyFile(join(dir, 'l.jsonl'))).ok, true);
  });
});

describe('AutomationEngine', () => {
  it('runs each idempotency key at most once, including across a restart', async () => {
    const dir = await tmp();
    let runs = 0;
    const mk = (t: ManualTrigger) =>
      new AutomationEngine({ dir, sleep: noSleep, workflows: [{ id: 'w', triggers: [t], run: async () => (runs++, ok()) }] });
    const t1 = new ManualTrigger();
    const e1 = mk(t1);
    await e1.start();
    const a = await t1.fire('k1');
    const dup = await t1.fire('k1');
    await e1.idle();
    assert.equal(a.accepted, true);
    assert.equal(dup.duplicate, true);
    await e1.stop();
    const t2 = new ManualTrigger();
    const e2 = mk(t2);
    await e2.start();
    assert.equal((await t2.fire('k1')).duplicate, true);
    assert.equal((await t2.fire('k2')).accepted, true);
    await e2.idle();
    await e2.stop();
    assert.equal(runs, 2);
    assert.equal((await HashChainLedger.verifyFile(join(dir, 'ledger.jsonl'))).ok, true);
  });

  it('retries transient failures with backoff, then dead-letters; permanent errors skip retries', async () => {
    const dir = await tmp();
    const t = new ManualTrigger();
    const attempts: Record<string, number> = {};
    const delays: number[] = [];
    const e = new AutomationEngine({
      dir,
      backoffBaseMs: 100,
      sleep: async (ms) => void delays.push(ms),
      workflows: [
        {
          id: 'w',
          triggers: [t],
          maxAttempts: 3,
          run: async (ev) => {
            const k = ev.idempotencyKey;
            attempts[k] = (attempts[k] ?? 0) + 1;
            if (k === 'flaky' && attempts[k]! < 3) throw new Error('503 upstream');
            if (k === 'always') throw new Error('still broken');
            if (k === 'bad') throw new PermanentError('invalid input');
            return ok(k);
          },
        },
      ],
    });
    await e.start();
    for (const k of ['flaky', 'always', 'bad']) await t.fire(k);
    await e.idle();
    await e.stop();
    assert.equal(attempts['flaky'], 3);
    assert.equal(attempts['always'], 3);
    assert.equal(attempts['bad'], 1);
    assert.deepEqual(delays.slice(0, 2).sort(), [100, 200]);
    assert.equal((await readdir(join(dir, 'outbox/dead-letter'))).length, 2);
    assert.equal((await readdir(join(dir, 'outbox/decisions'))).length, 1);
    assert.equal(e.counters.failed, 2);
  });

  it('recovers work that was accepted but never settled (simulated crash)', async () => {
    const dir = await tmp();
    const t1 = new ManualTrigger();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const e1 = new AutomationEngine({
      dir,
      sleep: noSleep,
      workflows: [{ id: 'w', triggers: [t1], run: async () => (await gate, ok('first')) }],
    });
    await e1.start();
    await t1.fire('crashy', { claim: 7 });
    assert.equal((await readdir(join(dir, 'state/pending'))).length, 1); // persisted before the ack
    // "crash": abandon e1 without letting the job settle
    const seen: unknown[] = [];
    const t2 = new ManualTrigger();
    const e2 = new AutomationEngine({
      dir,
      sleep: noSleep,
      workflows: [{ id: 'w', triggers: [t2], run: async (ev) => (seen.push(ev.payload), ok('recovered')) }],
    });
    await e2.start();
    await e2.idle();
    assert.deepEqual(seen, [{ claim: 7 }]);
    assert.equal((await readdir(join(dir, 'state/pending'))).length, 0);
    assert.ok(e2.ledgerEntries.some((x) => x.type === 'job.recovered'));
    release();
    await e1.idle();
    await e2.stop();
  });

  it('enforces queue capacity and per-workflow rate limits', async () => {
    const dir = await tmp();
    const t = new ManualTrigger();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const e = new AutomationEngine({
      dir,
      sleep: noSleep,
      concurrency: 1,
      maxQueue: 2,
      workflows: [{ id: 'w', triggers: [t], maxRunsPerMinute: 4, run: async () => (await gate, ok()) }],
    });
    await e.start();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await t.fire(`k${i}`));
    // 1 running + 2 queued accepted; 4th hits queue_full before the rate limiter counts it; 5th/6th same
    assert.deepEqual(
      results.map((r) => r.accepted),
      [true, true, true, false, false, false],
    );
    assert.equal(results[3]?.reason, 'queue_full');
    release();
    await e.idle();
    const rl = await t.fire('after');
    const rl2 = await t.fire('after2');
    assert.equal(rl.accepted, true);
    assert.equal(rl2.reason, 'rate_limited'); // 4 accepted in the last minute (k0,k1,k2,after)
    await e.stop();
  });

  it('routes needs_human outcomes to their lane and never lets a lane escape the outbox', async () => {
    const dir = await tmp();
    const t = new ManualTrigger();
    const e = new AutomationEngine({
      dir,
      sleep: noSleep,
      workflows: [
        {
          id: 'w',
          triggers: [t],
          run: async () => ({ disposition: 'needs_human', lane: 'escalations/../../evil', summary: 's', output: {} }),
        },
      ],
    });
    await e.start();
    await t.fire('x');
    await e.idle();
    await e.stop();
    const lanes = await readdir(join(dir, 'outbox'), { recursive: true });
    assert.ok(lanes.some((l) => l.endsWith('.json')));
    assert.ok(!(await readdir(dir)).includes('evil'));
  });
});

describe('triggers', () => {
  const post = (port: number, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const r = request(
        { host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      r.on('error', reject);
      r.end(body);
    });

  it('webhook: verifies HMAC + timestamp, rejects replays and oversize bodies, dedupes redelivery', async () => {
    const dir = await tmp();
    const secret = 'a-sufficiently-long-shared-secret';
    let clock = Date.now();
    const hook = new WebhookTrigger('hook', { secret, port: 0, maxBodyBytes: 1024, toleranceSec: 300, now: () => clock });
    let runs = 0;
    const e = new AutomationEngine({ dir, sleep: noSleep, workflows: [{ id: 'w', triggers: [hook], run: async () => (runs++, ok()) }] });
    await e.start();
    const port = hook.address().port;
    const body = JSON.stringify({ claim: 1 });
    const ts = Math.floor(clock / 1000);
    const goodHeaders = { 'x-xo-timestamp': String(ts), 'x-xo-signature': WebhookTrigger.sign(secret, ts, body) };

    assert.equal((await post(port, body, goodHeaders)).status, 202);
    assert.equal((await post(port, body, goodHeaders)).status, 200); // redelivery → duplicate, not a second run
    assert.equal((await post(port, body, { ...goodHeaders, 'x-xo-signature': 'sha256=' + '0'.repeat(64) })).status, 401);
    assert.equal((await post(port, body + ' ', goodHeaders)).status, 401); // body tampered
    assert.equal((await post(port, body, {})).status, 401);
    const old = ts - 3600;
    assert.equal(
      (await post(port, body, { 'x-xo-timestamp': String(old), 'x-xo-signature': WebhookTrigger.sign(secret, old, body) })).status,
      401,
    ); // replay outside window
    const big = JSON.stringify({ pad: 'x'.repeat(5000) });
    const r413 = await post(port, big, { 'x-xo-timestamp': String(ts), 'x-xo-signature': WebhookTrigger.sign(secret, ts, big) }).catch(
      () => ({ status: 413 }),
    );
    assert.equal(r413.status, 413);
    await e.idle();
    await e.stop();
    assert.equal(runs, 1);
    clock += 1;
  });

  it('webhook: refuses weak secrets', () => {
    assert.throws(() => new WebhookTrigger('h', { secret: 'short' }), /at least 16/);
  });

  it('file drop: processes a dropped claim, moves it to done/, ignores re-drops, quarantines junk', async () => {
    const root = await tmp();
    const dropDir = join(root, 'inbox');
    const drop = new FileDropTrigger('drop', { dir: dropDir, pollMs: 25 });
    const seen: unknown[] = [];
    const e = new AutomationEngine({
      dir: join(root, 'engine'),
      sleep: noSleep,
      workflows: [{ id: 'w', triggers: [drop], run: async (ev) => (seen.push(ev.payload), ok()) }],
    });
    await e.start();
    await writeFile(join(dropDir, 'a.json'), JSON.stringify({ n: 1 }));
    await writeFile(join(dropDir, 'junk.json'), '{not json');
    const waitFor = async (f: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (await f()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timed out waiting');
    };
    await waitFor(async () => (await readdir(join(dropDir, 'done'))).includes('a.json'));
    await waitFor(async () => (await readdir(join(dropDir, 'failed'))).includes('junk.json'));
    await writeFile(join(dropDir, 'a-again.json'), JSON.stringify({ n: 1 })); // same content → duplicate
    await waitFor(async () => (await readdir(join(dropDir, 'done'))).includes('a-again.json'));
    await e.idle();
    await e.stop();
    assert.equal(seen.length, 1);
    assert.match(await readFile(join(dropDir, 'failed', 'junk.json.note.txt'), 'utf8'), /not valid JSON/);
  });

  it('schedule: the idempotency key is the time slot, so a double fire in one slot runs once', async () => {
    const dir = await tmp();
    const t = new ScheduleTrigger('tick', { everyMs: 1_000_000, runOnStart: true, now: () => 5_000_000 });
    const t2 = new ScheduleTrigger('tick', { everyMs: 1_000_000, runOnStart: true, now: () => 5_400_000 }); // same slot, "another instance"
    let runs = 0;
    const e = new AutomationEngine({ dir, sleep: noSleep, workflows: [{ id: 'w', triggers: [t, t2], run: async () => (runs++, ok()) }] });
    await e.start();
    await e.idle();
    await e.stop();
    assert.equal(runs, 1);
  });
});
void appendFile;

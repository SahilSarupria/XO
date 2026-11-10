import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FileEventInbox,
  MemoryEventInbox,
  RunStore,
  eventProblem,
  type EventInbox,
  type JournalEntry,
  type RunStoreLike,
} from '../src/index.js';
import { comp, external, harness } from './support.js';

const ev = (over: Record<string, unknown> = {}) =>
  ({ name: 'doc.received', correlation: 'c1', eventId: 'e1', payload: { amt: 42 }, ...over }) as any;

const inboxes: [string, () => Promise<{ inbox: EventInbox; now: { t: number } }>][] = [
  [
    'memory',
    async () => {
      const now = { t: 1_000_000 };
      return { inbox: new MemoryEventInbox({ now: () => now.t, ttlMs: 10_000 }), now };
    },
  ],
  [
    'file',
    async () => {
      const now = { t: 1_000_000 };
      return { inbox: new FileEventInbox(await mkdtemp(join(tmpdir(), 'xo-ev-')), { now: () => now.t, ttlMs: 10_000 }), now };
    },
  ],
];

for (const [label, make] of inboxes)
  describe(`event inbox (${label})`, () => {
    it('buffers, dedupes by eventId (even after consumption), and hands an event to one claimant only', async () => {
      const { inbox } = await make();
      assert.equal((await inbox.deliver(ev())).status, 'queued');
      assert.equal((await inbox.deliver(ev())).status, 'duplicate');
      const a = await inbox.claim('doc.received', 'c1', 'runA::w');
      assert.equal(a?.payload['amt'], 42);
      assert.equal(await inbox.claim('doc.received', 'c1', 'runB::w'), undefined); // already taken
      assert.equal((await inbox.deliver(ev())).status, 'duplicate'); // a sender retry after consumption is not a new event
      assert.equal(await inbox.claim('doc.received', 'c1', 'runB::w'), undefined);
    });
    it('the same claimant asking again gets the same event back (crash recovery), never a second one', async () => {
      const { inbox } = await make();
      await inbox.deliver(ev({ eventId: 'e1', payload: { amt: 1 } }));
      await inbox.deliver(ev({ eventId: 'e2', payload: { amt: 2 } }));
      const first = await inbox.claim('doc.received', 'c1', 'runA::w');
      const again = await inbox.claim('doc.received', 'c1', 'runA::w');
      assert.equal(first?.eventId, again?.eventId);
      assert.equal((await inbox.claim('doc.received', 'c1', 'runB::w'))?.eventId !== first?.eventId, true);
    });
    it('only the matching name and correlation are released, oldest first; expired events are not handed out', async () => {
      const { inbox, now } = await make();
      await inbox.deliver(ev({ eventId: 'old', payload: { amt: 1 } }));
      now.t += 100;
      await inbox.deliver(ev({ eventId: 'new', payload: { amt: 2 } }));
      await inbox.deliver(ev({ eventId: 'x', correlation: 'other' }));
      assert.equal(await inbox.claim('doc.received', 'nobody', 'r::w'), undefined);
      assert.equal(await inbox.claim('different.name', 'c1', 'r::w'), undefined);
      assert.equal((await inbox.claim('doc.received', 'c1', 'r1::w'))?.eventId, 'old');
      now.t += 20_000; // the remaining one is now older than the ttl
      assert.equal(await inbox.claim('doc.received', 'c1', 'r2::w'), undefined);
    });
    it('refuses malformed events instead of storing them', async () => {
      const { inbox } = await make();
      for (const bad of [
        ev({ name: '../../etc/passwd' }),
        ev({ name: '' }),
        ev({ eventId: 'a/b' }),
        ev({ correlation: '' }),
        ev({ payload: { n: { deep: 1 } } }),
        ev({ payload: [1] }),
        ev({ payload: { n: Number.POSITIVE_INFINITY } }),
        ev({ payload: { big: 'x'.repeat(20_000) } }),
      ])
        await assert.rejects(() => inbox.deliver(bad), /invalid event/);
    });
  });

it('file inbox: concurrent claimants never both get the same event, and nothing is left half-written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-ev-race-'));
  const inbox = new FileEventInbox(dir);
  await inbox.deliver(ev());
  const got = await Promise.all(Array.from({ length: 8 }, (_, i) => inbox.claim('doc.received', 'c1', `run${i}::w`)));
  assert.equal(got.filter((g) => g !== undefined).length, 1);
  assert.deepEqual(await readdir(join(dir, 'pending')), []);
});

it('eventProblem accepts a good event', () => assert.equal(eventProblem(ev()), undefined));

const waitStep = (extra: Record<string, unknown> = {}): any => ({
  id: 'w',
  type: 'wait',
  determinism: 'deterministic',
  timeoutMs: 30_000,
  for: { kind: 'event', name: 'doc.received', correlationKey: 'claim' },
  onTimeout: 'escalate',
  outputs: { amt: { type: 'number' } },
  ...extra,
});
const payAfter = (): any => ({
  id: 'pay',
  type: 'act',
  determinism: 'deterministic',
  needs: ['w'],
  timeoutMs: 1000,
  connector: 'bank',
  operation: 'pay',
  sideEffect: 'write',
  idempotencyKey: 'pay:{{input.claim}}',
  inputs: { amount: { from: 'steps.w.amt' } },
});

describe('runner: wait for an event', () => {
  async function setup(stepExtra: Record<string, unknown> = {}) {
    const ext = external();
    const h = await harness(comp([waitStep(stepExtra), payAfter()]), ext);
    const now = { t: 1_000_000 };
    const inbox = new MemoryEventInbox({ now: () => now.t });
    return {
      h,
      ext,
      now,
      inbox,
      mk: (store?: RunStoreLike) => h.mk({ events: inbox, now: () => now.t, ...(store ? { store } : {}) }).runner,
    };
  }

  it('is refused at construction when no inbox is configured', async () => {
    const h = await harness(comp([waitStep(), payAfter()]));
    assert.throws(() => h.mk().runner, /cannot run on this runner/);
  });

  it('parks the run, then an arriving event releases it exactly once and its payload reaches the next step', async () => {
    const s = await setup();
    const runner = s.mk();
    const r = await runner.start({ inputs: { amount: 1, claim: 'c1' } });
    assert.equal(r.state, 'waiting');
    assert.equal(s.ext.effects.length, 0);
    const d = await runner.deliverEvent(ev({ correlation: 'c1', payload: { amt: 77 } }));
    assert.equal(d.status, 'queued');
    assert.equal(d.resumed.length, 1);
    assert.equal((await runner.status(r.runId)).state, 'completed');
    assert.deepEqual(s.ext.effects, ['pay:77']);
    const again = await runner.deliverEvent(ev({ correlation: 'c1', payload: { amt: 77 } })); // the sender retries
    assert.equal(again.status, 'duplicate');
    assert.deepEqual(s.ext.effects, ['pay:77']);
  });

  it('an event that arrives first is buffered and found when the run reaches its wait', async () => {
    const s = await setup();
    const runner = s.mk();
    await runner.deliverEvent(ev({ correlation: 'c9', payload: { amt: 5 } }));
    const r = await runner.start({ inputs: { amount: 1, claim: 'c9' } });
    assert.equal(r.state, 'completed');
    assert.deepEqual(s.ext.effects, ['pay:5']);
  });

  it('an event for another correlation does not release the run; each run takes its own', async () => {
    const s = await setup();
    const runner = s.mk();
    const a = await runner.start({ inputs: { amount: 1, claim: 'A' }, dedupeKey: 'A' });
    const b = await runner.start({ inputs: { amount: 1, claim: 'B' }, dedupeKey: 'B' });
    await runner.deliverEvent(ev({ correlation: 'B', eventId: 'eb', payload: { amt: 2 } }));
    assert.equal((await runner.status(a.runId)).state, 'waiting');
    assert.equal((await runner.status(b.runId)).state, 'completed');
    await runner.deliverEvent(ev({ correlation: 'A', eventId: 'ea', payload: { amt: 1 } }));
    assert.deepEqual([...s.ext.effects].sort(), ['pay:1', 'pay:2']);
  });

  it('a different event name never releases the wait', async () => {
    const s = await setup();
    const runner = s.mk();
    const r = await runner.start({ inputs: { amount: 1, claim: 'c1' } });
    await runner.deliverEvent(ev({ name: 'other.thing', correlation: 'c1' }));
    assert.equal((await runner.status(r.runId)).state, 'waiting');
  });

  it('times out into an escalation (or a failure when the step says so); nothing proceeds on silence', async () => {
    const s = await setup();
    const runner = s.mk();
    const r = await runner.start({ inputs: { amount: 1, claim: 'late' } });
    s.now.t += 31_000;
    const t = await runner.tick();
    assert.equal(t[0]?.state, 'escalated');
    assert.equal(t[0]?.escalation?.code, 'EVENT_TIMEOUT');
    assert.equal(s.ext.effects.length, 0);
    void r;
    const f = await setup({ onTimeout: 'fail' });
    const fr = f.mk();
    await fr.start({ inputs: { amount: 1, claim: 'late' } });
    f.now.t += 31_000;
    assert.equal((await fr.tick())[0]?.state, 'failed');
  });

  it('an event whose payload does not match the declared outputs escalates; the pay step never runs', async () => {
    const s = await setup();
    const runner = s.mk();
    const r = await runner.start({ inputs: { amount: 1, claim: 'bad' } });
    await runner.deliverEvent(ev({ correlation: 'bad', payload: { amt: 'not a number' } }));
    const st = await runner.status(r.runId);
    assert.equal(st.state, 'escalated');
    assert.equal(st.escalation?.code, 'EVENT_INVALID');
    assert.equal(s.ext.effects.length, 0);
  });

  it('a crash after claiming but before journalling loses nothing: the resumed run gets the same event', async () => {
    const s = await setup();
    const inner = new RunStore(join(s.h.dir, 'runs'));
    let armed = true;
    const flaky: RunStoreLike = {
      create: (id) => inner.create(id),
      read: (id) => inner.read(id),
      list: () => inner.list(),
      append: async (id, type, data): Promise<JournalEntry> => {
        if (armed && type === 'event_received') {
          armed = false;
          throw new Error('simulated crash');
        }
        return inner.append(id, type, data);
      },
    };
    const first = s.mk(flaky);
    const r = await first.start({ inputs: { amount: 1, claim: 'crash' }, runId: 'rcrash' });
    assert.equal(r.state, 'waiting');
    await assert.rejects(() => first.deliverEvent(ev({ correlation: 'crash', payload: { amt: 9 } })), /simulated crash/);
    const resumed = await s.mk(inner).resume('rcrash');
    assert.equal(resumed.state, 'completed');
    assert.deepEqual(s.ext.effects, ['pay:9']);
  });
});

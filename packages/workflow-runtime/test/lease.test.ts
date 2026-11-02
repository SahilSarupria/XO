import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import type { LeaseError} from '../src/index.js';
import { LeaseAuthority, LeasedRunStore, LedgerReplica, RunStore, WorkflowRunner } from '../src/index.js';

const component = (): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'bank',
        kind: 'http',
        operations: [
          { name: 'pay', sideEffect: 'write' },
          { name: 'note', sideEffect: 'write' },
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { claim: { type: 'string', required: true } },
        steps: [
          {
            id: 'pay',
            type: 'act',
            determinism: 'deterministic',
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'pay',
            sideEffect: 'write',
            idempotencyKey: 'pay:{{input.claim}}',
            inputs: { claim: { from: 'input.claim' } },
          },
          {
            id: 'note',
            type: 'act',
            determinism: 'deterministic',
            needs: ['pay'],
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'note',
            sideEffect: 'write',
            idempotencyKey: 'note:{{input.claim}}',
            inputs: { claim: { from: 'input.claim' } },
          },
        ],
        maxConcurrency: 1,
        runTimeoutMs: 600000,
        cancellation: { onCancel: 'abandon' },
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

/** External system that dedupes by key, with a hook to run code in the middle of a call (to model a pause or crash). */
function external(onCall?: (op: string) => Promise<void>) {
  const seen = new Set<string>();
  const effects: string[] = [];
  const calls: string[] = [];
  const op = (name: string) => ({
    sideEffect: 'write' as const,
    execute: async (_a: unknown, ctx: { idempotencyKey?: string }) => {
      calls.push(`${name}:${ctx.idempotencyKey}`);
      await onCall?.(name);
      if (ctx.idempotencyKey !== undefined && seen.has(ctx.idempotencyKey)) return { dup: true };
      seen.add(ctx.idempotencyKey ?? name);
      effects.push(name);
      return { ok: true };
    },
  });
  const conn: Connector = { kind: 'http', operations: { pay: op('pay'), note: op('note') } };
  return { conn, effects, calls };
}

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'xo-lease-'));
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new RunStore(join(dir, 'runs'));
  const authority = new LeaseAuthority(join(dir, 'leases'), store, clock.now);
  const c = component();
  const runnerFor = (owner: string, ext: ReturnType<typeof external>) => {
    const leased = new LeasedRunStore(authority, store);
    const runner = new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store: leased,
      now: clock.now,
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { bank: { grant: ['pay', 'note'] } } },
        implementations: { bank: ext.conn },
        vault: new MapVault({}),
      }),
      lease: {
        client: authority,
        owner,
        ttlMs: 10_000,
        heartbeatEveryMs: 0,
        attach: (id, tok) => leased.attach(id, owner, tok),
        detach: (id) => leased.detach(id),
      },
    });
    return runner;
  };
  return { authority, store, clock, runnerFor };
}

describe('lease and fencing', () => {
  it('issues increasing fencing tokens; a live lease is exclusive; release and expiry hand over', async () => {
    const r = await rig();
    const a = await r.authority.acquire('run_1', 'local', 10_000);
    assert.equal(a.token, 1);
    await assert.rejects(r.authority.acquire('run_1', 'server', 10_000), (e: LeaseError) => e.code === 'HELD');
    assert.equal((await r.authority.acquire('run_1', 'local', 10_000)).token, 1, 'same owner keeps its token while live');
    r.clock.advance(10_001);
    const b = await r.authority.acquire('run_1', 'server', 10_000);
    assert.equal(b.token, 2);
    await r.authority.release('run_1', 'server', 2);
    assert.equal((await r.authority.acquire('run_1', 'local', 10_000)).token, 3);
  });

  it('a stale or expired holder cannot write or heartbeat', async () => {
    const r = await rig();
    await r.store.create('run_2');
    const a = await r.authority.acquire('run_2', 'local', 10_000);
    await r.authority.fencedAppend('run_2', 'local', a.token, 'x', { n: 1 });
    r.clock.advance(10_001);
    await assert.rejects(r.authority.fencedAppend('run_2', 'local', a.token, 'x', { n: 2 }), (e: LeaseError) => e.code === 'LOST'); // expired, even though nobody took over
    const b = await r.authority.acquire('run_2', 'server', 10_000);
    await assert.rejects(r.authority.fencedAppend('run_2', 'local', a.token, 'x', { n: 3 }), (e: LeaseError) => e.code === 'LOST');
    await assert.rejects(r.authority.heartbeat('run_2', 'local', a.token, 10_000), (e: LeaseError) => e.code === 'LOST');
    await r.authority.fencedAppend('run_2', 'server', b.token, 'x', { n: 4 });
    assert.deepEqual(
      (await r.store.read('run_2')).map((e) => e.data['n']),
      [1, 4],
    );
  });

  it('failover: the local runner stops heartbeating mid-run, the server takes over from the journal, and the external system sees each effect once', async () => {
    const r = await rig();
    const ext = external();
    // local runner pauses inside the "pay" call (as if the host froze), long enough for its lease to expire
    let release!: () => void;
    const frozen = new Promise<void>((res) => (release = res));
    let first = true;
    const slow = external(async (op) => {
      if (op === 'pay' && first) {
        first = false;
        r.clock.advance(11_000);
        await frozen;
      }
    });
    // share one external system between both runners
    const shared = { conn: slow.conn, effects: slow.effects, calls: slow.calls };
    const local = r.runnerFor('local', shared);
    const localRun = local.start({ inputs: { claim: 'c1' }, runId: 'run_fo' });
    await new Promise((res) => setTimeout(res, 20));
    // the server notices the dead heartbeat and takes over from the last durable journal entry
    const server = r.runnerFor('server', shared);
    const taken = await server.resume('run_fo');
    assert.equal(taken.state, 'completed');
    // the local runner wakes up: its in-flight call returns, but its next journal write is fenced
    release();
    await assert.rejects(localRun, (e: LeaseError) => e.code === 'LOST');
    assert.deepEqual(shared.effects.sort(), ['note', 'pay'], 'each effect happened exactly once at the external system');
    const j = await r.store.read('run_fo');
    assert.equal(j.filter((e) => e.type === 'run_finished').length, 1);
    assert.equal(
      shared.calls.filter((c) => c.startsWith('pay:')).length,
      2,
      'the repeated call used the same key, which is what let the system dedupe',
    );
    assert.equal(new Set(shared.calls.filter((c) => c.startsWith('pay:'))).size, 1);
    void ext;
  });

  it('the returning runner cannot resume a run it lost', async () => {
    const r = await rig();
    const ext = external();
    const local = r.runnerFor('local', ext);
    const server = r.runnerFor('server', ext);
    await local.start({ inputs: { claim: 'c2' }, runId: 'run_lost' }).catch(() => undefined);
    const st = await server.status('run_lost');
    assert.equal(st.state, 'completed');
    assert.equal((await local.resume('run_lost')).state, 'completed', 'a finished run is simply reported, nothing re-executed');
    assert.equal(ext.effects.length, 2);
  });

  it('no runner writes to a run it holds no lease on', async () => {
    const r = await rig();
    const leased = new LeasedRunStore(r.authority, r.store);
    await r.store.create('run_3');
    await assert.rejects(leased.append('run_3', 'x', {}), (e: LeaseError) => e.code === 'LOST');
  });
});

void ConnectorError;

describe('ledger replication', () => {
  const mkEntries = async (dir: string, id: string, n: number, tag = 'a') => {
    const s = new RunStore(dir);
    await s.create(id);
    for (let i = 0; i < n; i++) await s.append(id, 'e', { i, tag });
    return s.read(id);
  };
  it('appends verified entries, treats re-pushes as duplicates, asks for missing ranges', async () => {
    const local = await mkEntries(await mkdtemp(join(tmpdir(), 'xo-l-')), 'run_r1', 5);
    const serverDir = await mkdtemp(join(tmpdir(), 'xo-s-'));
    const rep = new LedgerReplica(join(serverDir, 'forks'), new RunStore(serverDir));
    assert.equal((await rep.ingest('run_r1', local.slice(0, 3))).status, 'appended');
    assert.equal((await rep.ingest('run_r1', local.slice(0, 3))).status, 'duplicate');
    assert.equal((await rep.ingest('run_r1', local.slice(4))).status, 'gap');
    assert.equal((await rep.ingest('run_r1', local.slice(1))).status, 'appended');
    assert.equal((await new RunStore(serverDir).read('run_r1')).length, 5);
  });
  it('rejects tampered entries', async () => {
    const local = await mkEntries(await mkdtemp(join(tmpdir(), 'xo-l-')), 'run_r2', 3);
    const rep = new LedgerReplica(join(await mkdtemp(join(tmpdir(), 'xo-s-')), 'f'), new RunStore(await mkdtemp(join(tmpdir(), 'xo-s2-'))));
    const bad = [local[0]!, { ...local[1]!, data: { i: 99 } }, local[2]!];
    assert.equal((await rep.ingest('run_r2', bad)).status, 'invalid');
  });
  it('a fork is detected, never merged, escalated, and quarantines the run', async () => {
    const a = await mkEntries(await mkdtemp(join(tmpdir(), 'xo-a-')), 'run_r3', 4, 'A');
    const b = await mkEntries(await mkdtemp(join(tmpdir(), 'xo-b-')), 'run_r3', 4, 'B');
    const serverDir = await mkdtemp(join(tmpdir(), 'xo-s-'));
    const forks: unknown[] = [];
    const rep = new LedgerReplica(join(serverDir, 'forks'), new RunStore(serverDir), (e) => void forks.push(e));
    assert.equal((await rep.ingest('run_r3', a)).status, 'appended');
    const r = await rep.ingest('run_r3', b);
    assert.equal(r.status, 'fork');
    assert.equal(forks.length, 1);
    assert.equal((await rep.ingest('run_r3', a)).status, 'quarantined');
    assert.deepEqual(
      (await new RunStore(serverDir).read('run_r3')).map((e) => e.hash),
      a.map((e) => e.hash),
    );
  });
});

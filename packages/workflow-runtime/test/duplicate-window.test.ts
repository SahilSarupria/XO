import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ConnectorError,
  ConnectorHost,
  MapVault,
  type Connector,
  type ConnectorPolicy,
  type IdempotencyAttestation,
  type Json,
} from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import { RunStore, WorkflowRunner, reconcile, type Escalation } from '../src/index.js';

/**
 * Exactly-once against an arbitrary external system is impossible, and nothing here claims it. What is tested is the strongest thing that CAN be
 * promised, per kind of destination, under a process that dies at the worst possible moment:
 *   supports_key    -> the destination saw at most one effect, and the run completes;
 *   supports_lookup -> the destination saw at most one effect, and the run completes (it asks before repeating);
 *   none            -> the destination saw at most one effect, and when the outcome is unknown the run ESCALATES with the ambiguity rather than writing again.
 * The one thing that is never allowed is a second effect that nobody was told about.
 */

class Crash extends Error {}

/** A journal that "loses the process" around its Nth append: either before that entry is durable, or right after it is. */
class CrashingStore extends RunStore {
  appends = 0;
  constructor(
    dir: string,
    private readonly at: number,
    private readonly when: 'before' | 'after',
  ) {
    super(dir);
  }
  override async append(runId: string, type: string, data: Readonly<Record<string, unknown>>) {
    this.appends++;
    if (this.appends === this.at && this.when === 'before') throw new Crash(`died before append #${this.at} (${type})`);
    const e = await super.append(runId, type, data);
    if (this.appends === this.at && this.when === 'after') throw new Crash(`died after append #${this.at} (${type})`);
    return e;
  }
}

type Dest = 'supports_key' | 'supports_lookup' | 'none';

/** The outside world. It only ever grows: effects are never rolled back by a crash of OUR process. */
function world(dest: Dest) {
  const effects: { id: string; key: string | undefined }[] = [];
  const seenKeys = new Set<string>();
  const calls: string[] = [];
  /** Optional hook: runs inside `pay` AFTER the effect, to model "it worked but we never heard back". */
  const after: { fail?: () => never } = {};
  const conn: Connector = {
    kind: 'http',
    operations: {
      pay: {
        sideEffect: 'write',
        execute: async (args, ctx) => {
          calls.push(`pay:${String(args['id'])}`);
          // only a destination of kind supports_key deduplicates on the key we send
          if (dest === 'supports_key' && ctx.idempotencyKey !== undefined && seenKeys.has(ctx.idempotencyKey))
            return { paid: args['id'] as Json, replay: true };
          if (ctx.idempotencyKey !== undefined) seenKeys.add(ctx.idempotencyKey);
          effects.push({ id: String(args['id']), key: ctx.idempotencyKey });
          after.fail?.();
          return { paid: args['id'] as Json };
        },
      },
      notify: {
        sideEffect: 'write',
        execute: async (args, ctx) => {
          calls.push(`notify:${String(args['id'])}`);
          if (dest === 'supports_key' && ctx.idempotencyKey !== undefined && seenKeys.has(ctx.idempotencyKey)) return { sent: true };
          if (ctx.idempotencyKey !== undefined) seenKeys.add(ctx.idempotencyKey);
          effects.push({ id: `notify:${String(args['id'])}`, key: ctx.idempotencyKey });
          return { sent: true };
        },
      },
      find: {
        sideEffect: 'read',
        execute: async (args) => (calls.push(`find:${String(args['id'])}`), { found: effects.some((e) => e.id === String(args['id'])) }),
      },
    },
  };
  return { effects, calls, conn, after };
}

const attest = (dest: Dest): Record<string, IdempotencyAttestation> => {
  if (dest === 'none') return {};
  const lookupFor = (op: string, idExpr: string): IdempotencyAttestation =>
    dest === 'supports_key'
      ? { mode: 'supports_key' }
      : { mode: 'supports_lookup', lookup: { operation: 'find', args: { id: idExpr }, foundWhen: { field: 'found', equals: true } } };
  return { pay: lookupFor('pay', '{arg.id}'), notify: lookupFor('notify', 'notify:{arg.id}') };
};

const component = (): WorkflowComponent => {
  const act = (id: string, op: string, needs: string[]) => ({
    id,
    type: 'act',
    determinism: 'deterministic',
    needs,
    inputs: { id: { from: 'input.id' } },
    timeoutMs: 1000,
    retry: { maxAttempts: 3, backoff: { kind: 'exponential', baseMs: 1, maxMs: 2, jitter: 'none' } },
    connector: 'bank',
    operation: op,
    sideEffect: 'write',
    idempotencyKey: `${op}:{{input.id}}`,
    onError: 'fail',
  });
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'bank',
        kind: 'http',
        operations: [
          { name: 'pay', sideEffect: 'write' },
          { name: 'notify', sideEffect: 'write' },
          { name: 'find', sideEffect: 'read' },
        ],
      },
    ],
    workflows: [
      {
        id: 'settle',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { id: { type: 'string', required: true } },
        steps: [act('pay_step', 'pay', []), act('notify_step', 'notify', ['pay_step'])],
        result: { id: { from: 'input.id' } },
        requiresFeatures: [],
        maxConcurrency: 1,
        runTimeoutMs: 60000,
        cancellation: { onCancel: 'abandon' },
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(JSON.parse(JSON.stringify(c))).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

function build(dest: Dest, w: ReturnType<typeof world>, store: RunStore) {
  const comp = component();
  const policy: ConnectorPolicy = {
    connectors: { bank: { grant: ['pay', 'notify', 'find'], ...(dest === 'none' ? {} : { idempotency: attest(dest) }) } },
  };
  const escalations: Escalation[] = [];
  const runner = new WorkflowRunner({
    component: comp,
    workflowId: 'settle',
    store,
    connectors: new ConnectorHost({ component: comp, policy, implementations: { bank: w.conn }, vault: new MapVault({}) }),
    sleep: async () => undefined,
    onEscalate: (e) => void escalations.push(e),
  });
  return { runner, escalations };
}

const DESTS: Dest[] = ['supports_key', 'supports_lookup', 'none'];

describe('a process that dies at EVERY journal boundary (before and after each append)', () => {
  for (const dest of DESTS) {
    it(`${dest}: the destination never sees a second effect, and nothing is silently lost`, async () => {
      // learn how many journal appends an uninterrupted run makes
      const probeDir = await mkdtemp(join(tmpdir(), 'xo-probe-'));
      const probe = new CrashingStore(probeDir, Number.MAX_SAFE_INTEGER, 'before');
      const p = build(dest, world(dest), probe);
      assert.equal((await p.runner.start({ runId: 'r', inputs: { id: 'A1' } })).state, 'completed');
      const total = probe.appends;
      assert.ok(total >= 8, `unexpectedly few journal appends (${total})`);

      let ambiguousRuns = 0;
      let checked = 0;
      for (const when of ['before', 'after'] as const) {
        for (let at = 1; at <= total; at++) {
          const dir = await mkdtemp(join(tmpdir(), 'xo-crash-'));
          const w = world(dest);
          const label = `${dest} crash ${when} append #${at}`;

          const crashing = build(dest, w, new CrashingStore(dir, at, when));
          await crashing.runner.start({ runId: 'r', inputs: { id: 'A1' } }).then(
            () => undefined,
            (e: unknown) => assert.ok(e instanceof Crash, `${label}: unexpected error ${String(e)}`),
          );

          // the process restarts: a fresh store over the same directory, a fresh runner, the SAME outside world
          const restarted = build(dest, w, new RunStore(dir));
          const exists = (await new RunStore(dir).list()).includes('r');
          // a journal with no entries means the process died before anything happened: there is nothing to resume
          const result = exists
            ? await restarted.runner.resume('r').catch((e: unknown) => (/unknown run/.test(String(e)) ? undefined : Promise.reject(e)))
            : undefined;
          if (result === undefined) {
            assert.equal(w.effects.length, 0, `${label}: nothing was journalled yet an effect happened`);
            continue;
          }
          checked++;

          // THE invariant: at most one effect per business item, whatever happened
          const byItem = new Map<string, number>();
          for (const e of w.effects) byItem.set(e.id, (byItem.get(e.id) ?? 0) + 1);
          for (const [item, n] of byItem) assert.ok(n <= 1, `${label}: ${item} happened ${n} times; calls: ${w.calls.join(', ')}`);

          if (dest === 'none') {
            // an unknown outcome must be an escalation that says so; a known one must complete
            if (result.state === 'escalated') {
              ambiguousRuns++;
              assert.equal(
                result.escalation?.code,
                'AMBIGUOUS_EFFECT',
                `${label}: escalated for the wrong reason: ${JSON.stringify(result.escalation)}`,
              );
              assert.match(result.escalation?.reason ?? '', /may have taken effect/);
              const report = await reconcile(new RunStore(dir));
              assert.ok(report.needsAttention, `${label}: reconcile did not flag the ambiguity`);
              assert.ok(report.effects.some((x) => x.status === 'ambiguous'));
            } else {
              assert.equal(result.state, 'completed', `${label}: ${JSON.stringify(result)}`);
            }
          } else {
            assert.equal(
              result.state,
              'completed',
              `${label}: a destination that can dedupe or answer must let the run complete: ${JSON.stringify(result)}`,
            );
            // and every item was effected exactly once by the end
            assert.deepEqual([...byItem.keys()].sort(), ['A1', 'notify:A1'], `${label}: something was lost`);
          }
        }
      }
      assert.ok(checked > total, `${dest}: too few crash points were actually exercised`);
      if (dest === 'none') assert.ok(ambiguousRuns > 0, 'no crash point ever produced an ambiguity: the test is not exercising the window');
    });
  }
});

describe('in-process ambiguity (the call timed out, or died after the effect)', () => {
  const flaky = (w: ReturnType<typeof world>, times = 1) => {
    let n = 0;
    w.after.fail = () => {
      if (n++ < times) throw new ConnectorError('TIMEOUT', 'no response');
      return undefined as never;
    };
  };
  const run = async (dest: Dest, prep: (w: ReturnType<typeof world>) => void) => {
    const w = world(dest);
    prep(w);
    const dir = await mkdtemp(join(tmpdir(), 'xo-flaky-'));
    const { runner, escalations } = build(dest, w, new RunStore(dir));
    const r = await runner.start({ runId: 'r', inputs: { id: 'B2' } });
    return { w, r, escalations, dir };
  };

  it('supports_key: the retry re-sends under the same key and the destination dedupes', async () => {
    const { w, r } = await run('supports_key', flaky);
    assert.equal(r.state, 'completed');
    assert.equal(w.effects.filter((e) => e.id === 'B2').length, 1);
    assert.equal(w.calls.filter((c) => c === 'pay:B2').length, 2, 'it did retry');
    assert.equal(new Set(w.effects.map((e) => e.key)).size, w.effects.length);
  });
  it('supports_lookup: it asks the destination, finds the effect, and ADOPTS it instead of writing again', async () => {
    const { w, r, dir } = await run('supports_lookup', flaky);
    assert.equal(r.state, 'completed');
    assert.equal(w.effects.filter((e) => e.id === 'B2').length, 1);
    assert.equal(w.calls.filter((c) => c === 'pay:B2').length, 1, 'a second write was sent');
    assert.ok(w.calls.includes('find:B2'));
    const rep = await reconcile(new RunStore(dir));
    assert.equal(rep.needsAttention, false);
    assert.ok(rep.effects.some((x) => x.status === 'resolved' && /adopted/.test(x.detail)));
  });
  it('supports_lookup: when the lookup CONFIRMS the effect is absent, it writes (once)', async () => {
    // the call times out BEFORE the effect: nothing happened
    const { w, r } = await run('supports_lookup', (x) => {
      let n = 0;
      const real = x.conn.operations['pay']!.execute;
      x.conn.operations['pay']!.execute = async (a, c) => {
        if (n++ === 0) throw new ConnectorError('TIMEOUT', 'never arrived');
        return real(a, c);
      };
    });
    assert.equal(r.state, 'completed');
    assert.equal(w.effects.filter((e) => e.id === 'B2').length, 1);
  });
  it('supports_lookup: when the lookup ITSELF fails, it is still unknown, so it escalates and does not write', async () => {
    const { w, r, escalations } = await run('supports_lookup', (x) => {
      flaky(x);
      x.conn.operations['find']!.execute = async () => {
        throw new ConnectorError('FAILED', 'lookup service down');
      };
    });
    assert.equal(r.state, 'escalated');
    assert.equal(escalations.at(-1)?.code, 'AMBIGUOUS_EFFECT');
    assert.match(escalations.at(-1)?.reason ?? '', /checking the destination failed/);
    assert.equal(w.effects.filter((e) => e.id === 'B2').length, 1);
    assert.equal(w.calls.filter((c) => c === 'pay:B2').length, 1);
  });
  it('none: a timeout after the effect is NEVER retried; the run escalates naming the ambiguity and the key', async () => {
    const { w, r, escalations, dir } = await run('none', flaky);
    assert.equal(r.state, 'escalated');
    const e = escalations.at(-1)!;
    assert.equal(e.code, 'AMBIGUOUS_EFFECT');
    assert.match(e.reason, /bank\.pay/);
    assert.match(e.reason, /no duplicate protection \(idempotency: none\)/);
    assert.match(e.reason, /idempotency key/);
    assert.equal(w.calls.filter((c) => c === 'pay:B2').length, 1, 'it sent the write again');
    assert.equal(w.effects.filter((x) => x.id === 'B2').length, 1);
    const rep = await reconcile(new RunStore(dir));
    assert.equal(rep.needsAttention, true);
    assert.deepEqual(
      rep.effects.map((x) => [x.connector, x.operation, x.status]),
      [['bank', 'pay', 'ambiguous']],
    );
  });
  it('none: a failure that PROVES nothing was sent is still retried automatically', async () => {
    const { w, r } = await run('none', (x) => {
      let n = 0;
      const real = x.conn.operations['pay']!.execute;
      x.conn.operations['pay']!.execute = async (a, c) => {
        if (n++ === 0) throw new ConnectorError('FAILED', 'connection refused', 'none');
        return real(a, c);
      };
    });
    assert.equal(r.state, 'completed');
    assert.equal(w.effects.filter((e) => e.id === 'B2').length, 1);
  });
  it('an unattested destination is treated as none: the safe default is to ask a person', async () => {
    const w = world('none');
    flaky(w);
    const comp = component();
    const dir = await mkdtemp(join(tmpdir(), 'xo-default-'));
    const runner = new WorkflowRunner({
      component: comp,
      workflowId: 'settle',
      store: new RunStore(dir),
      connectors: new ConnectorHost({
        component: comp,
        policy: { connectors: { bank: { grant: ['pay', 'notify', 'find'] } } },
        implementations: { bank: w.conn },
        vault: new MapVault({}),
      }),
      sleep: async () => undefined,
    });
    assert.equal((await runner.start({ runId: 'r', inputs: { id: 'C3' } })).state, 'escalated');
  });
});

describe('attestations are validated when the host starts (a wrong attestation is a duplicate waiting to happen)', () => {
  const host = (idempotency: Record<string, unknown>, grant = ['pay', 'notify', 'find']) =>
    new ConnectorHost({
      component: component(),
      policy: { connectors: { bank: { grant, idempotency } as never } },
      implementations: { bank: world('none').conn },
      vault: new MapVault({}),
    });
  it('refuses attestations that are incomplete, misplaced or unsafe', () => {
    assert.throws(() => host({ ghost: { mode: 'supports_key' } }), /not declared/);
    assert.throws(() => host({ find: { mode: 'supports_key' } }), /reads need no attestation/);
    assert.throws(() => host({ pay: { mode: 'sometimes' } }), /mode must be/);
    assert.throws(() => host({ pay: { mode: 'supports_lookup' } }), /needs a "lookup"/);
    assert.throws(
      () => host({ pay: { mode: 'supports_key', lookup: { operation: 'find', args: {}, foundWhen: { field: 'found', equals: true } } } }),
      /applies only to supports_lookup/,
    );
    assert.throws(
      () =>
        host({ pay: { mode: 'supports_lookup', lookup: { operation: 'notify', args: {}, foundWhen: { field: 'found', equals: true } } } }),
      /declared read operation/,
    );
    assert.throws(
      () =>
        host({ pay: { mode: 'supports_lookup', lookup: { operation: 'nope', args: {}, foundWhen: { field: 'found', equals: true } } } }),
      /declared read operation/,
    );
    assert.throws(
      () =>
        host({ pay: { mode: 'supports_lookup', lookup: { operation: 'find', args: {}, foundWhen: { field: 'a.b.c.d', equals: true } } } }),
      /dot path/,
    );
    assert.throws(
      () =>
        host({ pay: { mode: 'supports_lookup', lookup: { operation: 'find', args: {}, foundWhen: { field: 'found', equals: true } } } }, [
          'pay',
          'notify',
        ]),
      /not granted/,
    );
    assert.doesNotThrow(() =>
      host({
        pay: {
          mode: 'supports_lookup',
          lookup: { operation: 'find', args: { id: '{arg.id}' }, foundWhen: { field: 'found', equals: true } },
        },
      }),
    );
  });
  it('the host reports what it will assume', () => {
    const h = host({ pay: { mode: 'supports_key' } });
    assert.deepEqual(h.idempotencyOf('bank', 'pay'), { mode: 'supports_key' });
    assert.deepEqual(h.idempotencyOf('bank', 'notify'), { mode: 'none' });
    assert.deepEqual(h.idempotencyOf('nope', 'x'), { mode: 'none' });
  });
  it('a lookup that cannot be filled in is ambiguity, not a guess', async () => {
    const w = world('supports_lookup');
    w.after.fail = () => {
      throw new ConnectorError('TIMEOUT', 'x');
    };
    const comp = component();
    const policy: ConnectorPolicy = {
      connectors: {
        bank: {
          grant: ['pay', 'notify', 'find'],
          idempotency: {
            pay: {
              mode: 'supports_lookup',
              lookup: { operation: 'find', args: { id: '{arg.missing}' }, foundWhen: { field: 'found', equals: true } },
            },
          },
        },
      },
    };
    const escalations: Escalation[] = [];
    const runner = new WorkflowRunner({
      component: comp,
      workflowId: 'settle',
      store: new RunStore(await mkdtemp(join(tmpdir(), 'xo-nolookup-'))),
      connectors: new ConnectorHost({ component: comp, policy, implementations: { bank: w.conn }, vault: new MapVault({}) }),
      sleep: async () => undefined,
      onEscalate: (e) => void escalations.push(e),
    });
    assert.equal((await runner.start({ runId: 'r', inputs: { id: 'D4' } })).state, 'escalated');
    assert.match(escalations.at(-1)?.reason ?? '', /needs \{arg\.missing\}/);
    assert.equal(w.calls.filter((c) => c === 'pay:D4').length, 1);
  });
});

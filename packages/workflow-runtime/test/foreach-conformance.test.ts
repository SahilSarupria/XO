/**
 * UW-7 (UAC-22) — runs every forEach conformance vector (`@xo/workflow-ir/conformance/foreach-vectors-1.0.json`) on this runtime.
 * The vectors say what any runtime must do; this file is only the harness that maps their destination behaviours onto a connector.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import { RunInputError, RunStore, WorkflowRunner, effectsOf, itemRunId } from '../src/index.js';

interface Vector {
  readonly name: string;
  readonly forEach: { readonly concurrency: number; readonly maxItems: number };
  readonly items: readonly Record<string, unknown>[];
  readonly cancelAfterDispatches?: number;
  readonly startAgainWithSameRunId?: boolean;
  readonly expect: {
    readonly inputRefused?: boolean;
    readonly parentState?: string;
    readonly outcome?: string;
    readonly escalationCode?: string;
    readonly itemStates?: readonly string[];
    readonly itemEscalationCodes?: Readonly<Record<string, string>>;
    readonly effectStates?: Readonly<Record<string, string>>;
    readonly dispatchesPerItem: number;
    readonly maxConcurrentDispatches?: number;
    readonly secondStartAccepted?: boolean;
    readonly settledItemsStand?: boolean;
    readonly noDispatchAfterCancel?: boolean;
    readonly maxDispatchesAfterRequest?: number;
  };
}

const require = createRequire(import.meta.url);
const vectorsPath = require.resolve('@xo/workflow-ir/conformance/foreach-vectors-1.0.json');

function component(v: Vector): WorkflowComponent {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'dest', kind: 'http', operations: [{ name: 'send', sideEffect: 'write' }] }],
    workflows: [
      {
        id: 'batch',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { items: { type: 'json', required: true, maxBytes: 100_000 } },
        steps: [
          {
            id: 'send',
            type: 'act',
            determinism: 'deterministic',
            timeoutMs: 5000,
            connector: 'dest',
            operation: 'send',
            sideEffect: 'write',
            inputs: { ref: { from: 'item.ref' }, destination: { from: 'item.destination' } },
            idempotencyKey: 'send:{{item.ref}}',
          },
        ],
        forEach: { over: 'items', ...v.forEach },
        maxConcurrency: Math.max(1, v.forEach.concurrency),
        runTimeoutMs: 60_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['for_each'],
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
}

describe('forEach conformance vectors (UAC-22)', async () => {
  const doc = JSON.parse(await readFile(vectorsPath, 'utf8')) as { formatVersion: string; vectors: Vector[] };
  it('the vector file is the version this runtime implements', () => {
    assert.equal(doc.formatVersion, '1.0');
    assert.ok(doc.vectors.length >= 10);
  });

  for (const v of doc.vectors)
    it(v.name, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'xo-fe-vec-'));
      const sends = new Map<string, number>();
      let live = 0;
      let peak = 0;
      let dispatched = 0;
      let atRequest: number | undefined;
      let runner!: WorkflowRunner;
      let cancelling: Promise<unknown> | undefined;
      const conn: Connector = {
        kind: 'http',
        operations: {
          send: {
            sideEffect: 'write',
            idempotency: 'none',
            execute: async (a) => {
              const ref = String(a['ref']);
              sends.set(ref, (sends.get(ref) ?? 0) + 1);
              dispatched++;
              live++;
              peak = Math.max(peak, live);
              try {
                if (v.cancelAfterDispatches !== undefined && dispatched === v.cancelAfterDispatches) {
                  cancelling = runner.cancel('vec', { by: 'conformance' }).then((r) => {
                    atRequest ??= dispatched;
                    return r;
                  });
                }
                await new Promise((r) => setTimeout(r, 3));
                if (a['destination'] === 'refuse') throw new ConnectorError('INVALID', 'refused by the destination');
                if (a['destination'] === 'unknown') throw new ConnectorError('TIMEOUT', 'no answer');
                return { id: `m_${ref}` };
              } finally {
                live--;
              }
            },
          },
        },
      };
      const c = component(v);
      runner = new WorkflowRunner({
        component: c,
        workflowId: 'batch',
        store: new RunStore(dir),
        connectors: new ConnectorHost({
          component: c,
          policy: { connectors: { dest: { grant: ['send'] } } },
          implementations: { dest: conn },
          vault: new MapVault({}),
        }),
        sleep: async () => undefined,
      });
      const start = () => runner.start({ inputs: { items: v.items as Record<string, unknown>[] }, runId: 'vec' });

      if (v.expect.inputRefused === true) {
        await assert.rejects(start(), (e) => e instanceof RunInputError);
        assert.equal(dispatched, 0);
        return;
      }
      const result = await start();
      await cancelling;
      if (v.expect.parentState !== undefined) assert.equal(result.state, v.expect.parentState, JSON.stringify(result.escalation));
      const summary = (result.outputs ?? {}) as { outcome?: string; items?: { state: string }[] };
      if (v.expect.outcome !== undefined) assert.equal(summary.outcome, v.expect.outcome);
      if (v.expect.escalationCode !== undefined) assert.equal(result.escalation?.code, v.expect.escalationCode);
      if (v.expect.itemStates !== undefined)
        assert.deepEqual(
          summary.items?.map((i) => i.state),
          v.expect.itemStates,
        );
      const store = new RunStore(dir);
      for (const [index, code] of Object.entries(v.expect.itemEscalationCodes ?? {})) {
        const status = await runner.status(itemRunId('vec', Number(index)));
        assert.equal(status.escalation?.code, code, `item ${index}`);
      }
      for (const [index, state] of Object.entries(v.expect.effectStates ?? {}))
        assert.deepEqual(
          effectsOf(await store.read(itemRunId('vec', Number(index)))).map((e) => e.state),
          [state],
          `item ${index}`,
        );
      if (v.cancelAfterDispatches === undefined)
        for (const it of v.items) assert.equal(sends.get(String(it['ref'])) ?? 0, v.expect.dispatchesPerItem, `item ${String(it['ref'])}`);
      else for (const n of sends.values()) assert.ok(n <= 1, 'no item is ever sent twice');
      if (v.expect.maxConcurrentDispatches !== undefined) assert.ok(peak <= v.expect.maxConcurrentDispatches, `peak ${peak}`);

      if (v.expect.noDispatchAfterCancel === true) {
        assert.ok(atRequest !== undefined);
        assert.ok(dispatched - v.cancelAfterDispatches! <= (v.expect.maxDispatchesAfterRequest ?? 0), `${dispatched} sent`);
        const before = dispatched;
        await runner.resume('vec');
        await runner.tick();
        assert.equal(dispatched, before, 'nothing is sent after the batch is cancelled');
      }
      if (v.expect.settledItemsStand === true)
        for (let i = 0; i < v.items.length; i++) {
          const ref = String(v.items[i]!['ref']);
          const st = (await runner.status(itemRunId('vec', i)).catch(() => undefined))?.state;
          if (sends.has(ref)) assert.equal(st, 'completed', `item ${i} was sent and stays completed`);
          else assert.ok(st === undefined || st === 'cancelled', `item ${i} was not sent (${st})`);
        }
      if (v.startAgainWithSameRunId === true) {
        const again = await start();
        assert.equal(again.accepted, v.expect.secondStartAccepted);
        for (const it of v.items) assert.equal(sends.get(String(it['ref'])), v.expect.dispatchesPerItem);
      }
    });
});

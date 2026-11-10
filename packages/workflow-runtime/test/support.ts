import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import { RunStore, WorkflowRunner } from '../src/index.js';

/** An "external system" that dedupes by idempotency key, like a payment API would. */
export function external(opts: { failFirst?: number; failCode?: ConnectorError['code'] } = {}) {
  const effects: string[] = [];
  const calls: { op: string; key?: string }[] = [];
  const seenKeys = new Set<string>();
  let failures = opts.failFirst ?? 0;
  const conn: Connector = {
    kind: 'http',
    operations: {
      get: { sideEffect: 'read', execute: async () => ({ v: 1 }) },
      pay: {
        sideEffect: 'write',
        idempotency: 'supports_key', // this fake dedupes on the key, like a payment API
        execute: async (args, ctx) => {
          calls.push({ op: 'pay', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
          if (failures > 0) {
            failures--;
            throw new ConnectorError(opts.failCode ?? 'FAILED', 'upstream down');
          }
          if (ctx.idempotencyKey !== undefined && seenKeys.has(ctx.idempotencyKey)) return { id: 'dup-suppressed' };
          seenKeys.add(ctx.idempotencyKey ?? `n${effects.length}`);
          effects.push(`pay:${String(args['amount'])}`);
          return { id: `pay_${effects.length}` };
        },
      },
      refund: {
        sideEffect: 'write',
        idempotency: 'supports_key',
        execute: async (args, ctx) => {
          calls.push({ op: 'refund', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
          effects.push(`refund:${String(args['amount'])}`);
          return { ok: true };
        },
      },
      ship: { sideEffect: 'irreversible', execute: async () => ({ shipped: true }) },
    },
  };
  return { conn, effects, calls };
}

export const comp = (steps: any[], extra: any = {}, ops: any[] = []): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'bank',
        kind: 'http',
        operations: [
          { name: 'get', sideEffect: 'read' },
          { name: 'pay', sideEffect: 'write' },
          { name: 'refund', sideEffect: 'write' },
          { name: 'ship', sideEffect: 'irreversible' },
          ...ops,
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { amount: { type: 'number', required: true }, claim: { type: 'string', required: true } },
        steps,
        maxConcurrency: 2,
        runTimeoutMs: 60_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: [],
        ...extra,
      },
    ],
  } as unknown as WorkflowComponent;
  // keep requiresFeatures honest for the validator
  const used = new Set<string>();
  for (const s of steps) {
    if (s.type === 'decide' && s.method.kind === 'rules') used.add('rules');
    if (s.type === 'act' && s.compensatedBy) used.add('compensation');
    if (s.type === 'compensate') used.add('compensation');
    if (s.type === 'wait') used.add(s.for.kind === 'event' ? 'wait_event' : 'wait_timer');
    if (s.type === 'approve') used.add('approve');
  }
  if (extra.authority) used.add('authority_ceilings');
  if (extra.forEach) used.add('for_each');
  (c.workflows[0] as any).requiresFeatures = [...used].sort();
  const v = validateWorkflowComponent(c);
  assert.deepEqual(
    v.issues.filter((i) => i.severity === 'error'),
    [],
    'fixture must itself be a valid workflow',
  );
  return c;
};

export const decide = (): any => ({
  id: 'check',
  type: 'decide',
  determinism: 'deterministic',
  timeoutMs: 1000,
  inputs: { amount: { from: 'input.amount' } },
  method: { kind: 'rules', rules: [{ id: 'ok', when: 'amount <= 1000', set: { verdict: 'pay' } }], onNoMatch: 'escalate' },
  outputs: { verdict: { type: 'enum', enum: ['pay'] } },
});
export const pay = (extra: any = {}): any => ({
  id: 'pay',
  type: 'act',
  determinism: 'deterministic',
  needs: ['check'],
  timeoutMs: 1000,
  connector: 'bank',
  operation: 'pay',
  sideEffect: 'write',
  inputs: { amount: { from: 'input.amount' }, verdict: { from: 'steps.check.verdict' } },
  idempotencyKey: 'pay:{{input.claim}}',
  ...extra,
});

export async function harness(c: WorkflowComponent, ext = external(), over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xo-run-'));
  const mk = (extra: Record<string, unknown> = {}) => {
    const store = new RunStore(dir);
    const host = new ConnectorHost({
      component: c,
      policy: { connectors: { bank: { grant: ['get', 'pay', 'refund', 'ship'] } } },
      implementations: { bank: ext.conn },
      vault: new MapVault({}),
    });
    const sleeps: number[] = [];
    const runner = new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store,
      connectors: host,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      ...over,
      ...extra,
    });
    return { runner, store, sleeps };
  };
  return { dir, mk, ext };
}

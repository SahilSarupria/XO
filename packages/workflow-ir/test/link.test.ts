import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linkWorkflowComponents, validateWorkflowComponent, type WorkflowComponent } from '../src/index.js';

const wf = (id: string, over: Record<string, unknown> = {}, connector = 'bank') => ({
  id,
  version: '1.0.0',
  triggers: [{ id: 't', kind: 'api' }],
  inputs: { a: { type: 'string', required: true } },
  steps: [
    {
      id: 'pay',
      type: 'act',
      determinism: 'deterministic',
      timeoutMs: 1000,
      connector,
      operation: 'pay',
      sideEffect: 'write',
      idempotencyKey: 'k:{{input.a}}',
      inputs: { a: { from: 'input.a' } },
    },
  ],
  maxConcurrency: 1,
  runTimeoutMs: 1000,
  cancellation: { onCancel: 'abandon' },
  ...over,
});
const comp = (workflows: unknown[], connectors?: unknown[]): WorkflowComponent =>
  ({
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: connectors ?? [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
    workflows,
  }) as unknown as WorkflowComponent;

describe('linking several XOs', () => {
  it('merges disjoint workflows and reports identical definitions as harmless overlaps', () => {
    const r = linkWorkflowComponents(
      [
        { xo: 'a', component: comp([wf('one'), wf('shared')]) },
        { xo: 'b', component: comp([wf('two'), wf('shared')]) },
      ],
      { order: ['a', 'b'] },
    );
    assert.deepEqual(
      r.component.workflows.map((w) => w.id),
      ['one', 'shared', 'two'],
    );
    assert.deepEqual(r.overlaps.map((o) => `${o.kind}:${o.key}`).sort(), ['connector:bank', 'workflow:shared']);
    assert.equal(r.hasUnresolved, false);
    assert.deepEqual(
      validateWorkflowComponent(r.component).issues.filter((i) => i.severity === 'error'),
      [],
    );
  });
  it('resolves a differing definition only by declared precedence, and reports it', () => {
    const a = comp([wf('x', { version: '1.0.0' })]);
    const b = comp([wf('x', { version: '2.0.0' })]);
    const r = linkWorkflowComponents(
      [
        { xo: 'a', component: a },
        { xo: 'b', component: b },
      ],
      { order: ['b', 'a'] },
    );
    assert.equal(r.component.workflows[0]?.version, '2.0.0');
    assert.deepEqual(
      r.conflicts.map((c) => c.resolution),
      ['precedence:b'],
    );
    assert.equal(r.hasUnresolved, false);
  });
  it('never guesses: with no applicable precedence both definitions are blocked and reported', () => {
    const r = linkWorkflowComponents(
      [
        { xo: 'a', component: comp([wf('x', { version: '1.0.0' })]) },
        { xo: 'b', component: comp([wf('x', { version: '2.0.0' })]) },
      ],
      { order: ['c'] },
    );
    assert.equal(r.component.workflows.length, 0);
    assert.equal(r.hasUnresolved, true);
    assert.equal(r.blocked.length, 2);
  });
  it('a connector declared differently by two XOs is a conflict; unresolved blocks every workflow that uses it', () => {
    const a = comp([wf('x')]);
    const b = comp([wf('y')], [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'irreversible' }] }]);
    const r = linkWorkflowComponents(
      [
        { xo: 'a', component: a },
        { xo: 'b', component: b },
      ],
      { order: [] },
    );
    assert.ok(r.conflicts.some((c) => c.kind === 'connector' && c.resolution === 'unresolved'));
    assert.deepEqual(r.blocked.map((x) => x.workflow).sort(), ['x', 'y']);
    assert.equal(r.component.workflows.length, 0);
  });
  it('two XOs claiming the same webhook route: the loser is blocked, or both when nothing decides', () => {
    const hook = { triggers: [{ id: 'h', kind: 'webhook', route: 'claims/in', auth: 'hmac' }] };
    const inputs = [
      { xo: 'a', component: comp([wf('one', hook)]) },
      { xo: 'b', component: comp([wf('two', hook)]) },
    ];
    const won = linkWorkflowComponents(inputs, { order: ['a', 'b'] });
    assert.deepEqual(
      won.component.workflows.map((w) => w.id),
      ['one'],
    );
    assert.match(won.blocked[0]?.reason ?? '', /loses webhook_route/);
    const none = linkWorkflowComponents(inputs, { order: [] });
    assert.equal(none.component.workflows.length, 0);
    assert.equal(none.hasUnresolved, true);
  });
});

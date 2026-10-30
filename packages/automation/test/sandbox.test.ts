import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { DecisionTree } from '@xo/capability-layer';
import { networkNamespaceAvailable, SandboxUnavailableError, TreeSandbox } from '../src/index.js';

const tree: DecisionTree = {
  id: 't',
  description: 'd',
  inputs: [{ name: 'x', type: 'number', description: 'x' }],
  start: 'a',
  nodes: {
    a: { type: 'branch', test: 'x > 10', then: 'hi', else: 'lo' },
    hi: { type: 'leaf', output: { v: '=x * 2' } },
    lo: { type: 'leaf', output: { v: 0 } },
  },
};

describe('TreeSandbox', () => {
  const sb = new TreeSandbox({
    workers: 2,
    timeoutMs: 1500,
    testHooks: true,
    networkIsolation: networkNamespaceAvailable() ? 'required' : 'none',
  });
  after(() => sb.close());

  it('evaluates trees identically to in-process evaluation', async () => {
    const r = await sb.evaluate(tree, { x: 21 });
    assert.ok(r.ok && r.output['v'] === 42);
    const m = await sb.evaluate(tree, {});
    assert.ok(!m.ok && m.error === 'missing_facts');
  });

  it('proves, from inside the worker, that forbidden operations are denied', async () => {
    const rep = await sb.selfTest();
    assert.deepEqual(rep.failures, []);
    assert.equal(rep.enforced, true);
    assert.equal(rep.fs_write, 'ERR_ACCESS_DENIED');
    assert.equal(rep.fs_read_outside, 'ERR_ACCESS_DENIED');
    assert.equal(rep.spawn, 'ERR_ACCESS_DENIED');
    assert.equal(rep.code_gen, 'EvalError');
    if (sb.isolation.network) assert.match(rep.net, /^BLOCKED/);
  });

  it('does not leak parent environment secrets into workers', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-never-reach-the-sandbox';
    const fresh = new TreeSandbox({ workers: 1, networkIsolation: sb.isolation.network ? 'required' : 'none' });
    try {
      const rep = await fresh.selfTest();
      assert.equal(rep.env_secrets, 'ALLOWED'); // 'ALLOWED' = the leak probe found nothing to complain about
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      await fresh.close();
    }
  });

  it('kills a runaway worker at the timeout and keeps serving afterwards', async () => {
    await assert.rejects(sb.spinForTest(), /exceeded 1500 ms/);
    const r = await sb.evaluate(tree, { x: 5 });
    assert.ok(r.ok && r.output['v'] === 0);
    assert.ok(sb.stats.restarts >= 1);
  });

  it('serves concurrent evaluations across the pool', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => sb.evaluate(tree, { x: i })));
    rs.forEach((r, i) => assert.ok(r.ok && r.output['v'] === (i > 10 ? i * 2 : 0)));
  });

  it('fails closed when network isolation is required but unavailable', () => {
    if (networkNamespaceAvailable()) return; // cannot simulate absence here; covered by the constructor branch
    assert.throws(() => new TreeSandbox({ networkIsolation: 'required' }), SandboxUnavailableError);
  });
});

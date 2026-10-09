import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId } from '../src/ids.js';
import { CancellationToken, PassManager, type Pass, type PassContext, type PassResult } from '../src/pass.js';

function makeGraph(): XoirGraph {
  return XoirGraph.create(XoirGraphId('g'));
}

/** A tag-adding pass, for contract-testing the framework — not a real optimization, per the module spec's "do not implement optimization." */
function makeTaggingPass(name: string, dependsOn: readonly string[] = []): Pass {
  return {
    name,
    dependsOn,
    run(context: PassContext): PassResult {
      context.diagnostics.push({ severity: 'info', message: `${name} ran`, passName: name });
      return { graph: context.graph };
    },
  };
}

test('PassManager runs a single registered pass', async () => {
  const manager = new PassManager();
  manager.register(makeTaggingPass('pass-a'));
  const result = await manager.run(makeGraph());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.runs.length, 1);
  assert.equal(result.value.runs[0]?.passName, 'pass-a');
});

test('PassManager orders passes to respect dependsOn', async () => {
  const manager = new PassManager();
  const order: string[] = [];
  manager.register({
    name: 'second',
    dependsOn: ['first'],
    run(context) {
      order.push('second');
      return { graph: context.graph };
    },
  });
  manager.register({
    name: 'first',
    run(context) {
      order.push('first');
      return { graph: context.graph };
    },
  });
  const result = await manager.run(makeGraph());
  assert.ok(result.ok);
  assert.deepEqual(order, ['first', 'second']);
});

test('PassManager detects a dependency cycle between passes', async () => {
  const manager = new PassManager();
  manager.register(makeTaggingPass('a', ['b']));
  manager.register(makeTaggingPass('b', ['a']));
  const result = await manager.run(makeGraph());
  assert.equal(result.ok, false);
});

test('PassManager collects diagnostics across all passes', async () => {
  const manager = new PassManager();
  manager.register(makeTaggingPass('a'));
  manager.register(makeTaggingPass('b'));
  const result = await manager.run(makeGraph());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.diagnostics.length, 2);
});

test('PassManager wraps a thrown error as an XOIR_PASS_FAILED result', async () => {
  const manager = new PassManager();
  manager.register({
    name: 'boom',
    run() {
      throw new Error('pass exploded');
    },
  });
  const result = await manager.run(makeGraph());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_XOIR_PASS_FAILED');
});

test('PassManager honors a pre-cancelled token by skipping remaining passes', async () => {
  const manager = new PassManager();
  const token = new CancellationToken();
  token.cancel();
  manager.register(makeTaggingPass('a'));
  const result = await manager.run(makeGraph(), { cancellationToken: token });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.runs[0]?.cancelled, true);
  assert.equal(result.value.diagnostics.length, 0);
});

test('PassManager threads the graph from one pass to the next', async () => {
  const manager = new PassManager();
  manager.register({
    name: 'adder',
    run(context) {
      context.graph.createAndAddNode({ id: XoirNodeId('added'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
      return { graph: context.graph };
    },
  });
  manager.register({
    name: 'checker',
    dependsOn: ['adder'],
    run(context) {
      context.diagnostics.push({ severity: 'info', passName: 'checker', message: `sees ${context.graph.stats().nodeCount} nodes` });
      return { graph: context.graph };
    },
  });
  const result = await manager.run(makeGraph());
  assert.ok(result.ok);
  if (!result.ok) return;
  const checkerRun = result.value.runs.find((r) => r.passName === 'checker');
  assert.match(checkerRun?.diagnostics[0]?.message ?? '', /sees 1 nodes/);
});
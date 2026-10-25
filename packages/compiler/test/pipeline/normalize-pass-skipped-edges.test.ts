import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noopLogger } from '@xo/logger';
import { CancellationToken, XoirEdgeId, XoirGraph, XoirGraphId, XoirNodeId, createEdge } from '@xo/xoir';
import { createXoirNormalizationPass, XOIR_NORMALIZATION_PASS_NAME } from '../../src/pipeline/normalize-pass.js';

function graphWithDanglingEdge() {
  const real = XoirGraph.create(XoirGraphId('g'), 1);
  const added = real.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' } });
  assert.ok(added.ok);
  const dangling = {
    ...createEdge({ id: XoirEdgeId('e1'), kind: 'depends_on', fromId: XoirNodeId('n1'), toId: XoirNodeId('ghost') }),
    hash: 'h',
  };
  // XoirGraph.addEdge refuses a dangling edge, so the "endpoint dropped upstream" case can only be
  // reached when something else hands the pass edges the graph never validated; model that here.
  const stub = Object.create(real) as XoirGraph;
  (stub as unknown as { allEdges: () => unknown[] }).allEdges = () => [dangling];
  return stub;
}

test('WS1-10: an edge skipped for a missing endpoint is reported, not silently dropped', () => {
  const pass = createXoirNormalizationPass();
  const result = pass.run({
    graph: graphWithDanglingEdge(),
    logger: noopLogger,
    cancellationToken: new CancellationToken(),
    diagnostics: [],
  });
  if (result instanceof Promise) throw new Error('normalization is synchronous');
  const diag = result.diagnostics?.find((d) => d.code === 'normalize/edge-skipped-missing-endpoint');
  assert.ok(diag, 'expected a skipped-edge diagnostic');
  assert.equal(diag!.severity, 'warning');
  assert.equal(diag!.passName, XOIR_NORMALIZATION_PASS_NAME);
  assert.match(diag!.message, /e1/);
  assert.match(diag!.message, /ghost/);
  assert.equal(result.graph.allEdges().length, 0);
});

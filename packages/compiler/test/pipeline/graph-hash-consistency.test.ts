import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, createManifest, toJson, fromJson } from '@xo/xoir';
import { ContentHash } from '@xo/types';
import { discoverAndResolveCapabilities } from '../../src/pipeline/capability-discovery.js';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';

/**
 * P0.9B Step 1 correctness: embedding contracts during lowering mutates
 * the graph, so the manifest's cached `graphHash` must be refreshed in the
 * same place — otherwise it names the pre-lowering graph while receipts
 * (built from `contentHash()`) name the post-lowering one.
 */
const now = () => '2026-01-01T00:00:00.000Z';

function graphWithManifest(withManifest = true): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('capability:c'), kind: 'capability', properties: { name: 'E', description: 'd', determinism: 'deterministic' }, confidence: 0.7, now });
  graph.createAndAddNode({ id: XoirNodeId('decision:d'), kind: 'decision_node', properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' }, confidence: 0.9, now });
  graph.createAndAddEdge({ id: XoirEdgeId('r'), kind: 'REQUIRES', fromId: XoirNodeId('decision:d'), toId: XoirNodeId('capability:c'), now });
  if (withManifest) graph.setManifest(createManifest({ schemaVersion: graph.schemaVersion, graphHash: ContentHash(graph.contentHash()), now }));
  return graph;
}

test('lowering embeds contracts (graph identity moves) and manifest.graphHash moves with it', () => {
  const graph = graphWithManifest();
  const before = graph.contentHash();
  const result = discoverAndResolveCapabilities(graph, { previewLabel: 't' });
  assert.ok(result.ok && result.value.resolvedCount === 1);
  assert.notEqual(graph.contentHash(), before, 'embedding must have changed the graph identity');
  assert.equal(graph.manifest?.graphHash, graph.contentHash());
});

test('the refreshed manifest survives the JSON round trip the API persists, and still equals the rehydrated graph identity', () => {
  const graph = graphWithManifest();
  assert.ok(discoverAndResolveCapabilities(graph, { previewLabel: 't' }).ok);
  const back = fromJson(JSON.parse(JSON.stringify(toJson(graph))));
  assert.ok(back.ok);
  assert.equal(back.value.manifest?.graphHash, back.value.contentHash());
  assert.equal(back.value.contentHash(), graph.contentHash());
});

test('a graph with no manifest is not given one by lowering', () => {
  const graph = graphWithManifest(false);
  lowerCapabilitiesToManifest(graph);
  assert.equal(graph.manifest, undefined);
});

test('lowering an already-embedded graph again is idempotent for graph identity (the API re-lowers a rehydrated graph)', () => {
  const graph = graphWithManifest();
  lowerCapabilitiesToManifest(graph);
  const once = graph.contentHash();
  lowerCapabilitiesToManifest(graph);
  assert.equal(graph.contentHash(), once);
  assert.equal(graph.manifest?.graphHash, once);
});

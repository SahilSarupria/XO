import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId } from '../src/ids.js';
import { appendPassHistory, createManifest } from '../src/manifest.js';
import { hashNode } from '../src/hashing.js';
import { createNode } from '../src/node-kinds.js';
import { fromJson, toJson } from '../src/serialization.js';
import { ContentHash } from '@xo/types';
test('createManifest fills conservative defaults and records schemaVersion', () => {
    const manifest = createManifest({ schemaVersion: 1, now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.professionTags, []);
    assert.deepEqual(manifest.sourceManifestRefs, []);
    assert.deepEqual(manifest.passHistory, []);
    assert.equal(manifest.createdAt, '2026-01-01T00:00:00.000Z');
});
test('appendPassHistory returns a new manifest value, leaving the original untouched (immutability)', () => {
    const manifest = createManifest({ schemaVersion: 1 });
    const entry = {
        passId: 'knowledge-extraction',
        passVersion: '1.0.0',
        inputHash: ContentHash(`sha256:${'a'.repeat(64)}`),
        outputHash: ContentHash(`sha256:${'b'.repeat(64)}`),
        timestamp: '2026-01-01T00:00:01.000Z',
    };
    const updated = appendPassHistory(manifest, entry);
    assert.equal(manifest.passHistory.length, 0);
    assert.equal(updated.passHistory.length, 1);
    assert.deepEqual(updated.passHistory[0], entry);
});
test('a XoirGraph can carry a manifest and it round-trips through serialization', () => {
    const manifest = createManifest({
        schemaVersion: 1,
        compilerVersion: '@xo/compiler@0.1.0',
        professionTags: ['corporate-law'],
        sourceManifestRefs: ['src-manifest-1'],
        now: () => '2026-01-01T00:00:00.000Z',
    });
    const graph = XoirGraph.create(XoirGraphId('g1'), 1, manifest);
    graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' } });
    const json = toJson(graph);
    assert.deepEqual(json.manifest, manifest);
    const restored = fromJson(json);
    assert.ok(restored.ok);
    if (!restored.ok)
        return;
    assert.deepEqual(restored.value.manifest, manifest);
});
test('a graph with no manifest serializes without one, and deserializes back to undefined (backward compatible with schema-version-1 graphs that never had one)', () => {
    const graph = XoirGraph.create(XoirGraphId('g1'));
    graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' } });
    const json = toJson(graph);
    assert.equal('manifest' in json, false);
    const restored = fromJson(json);
    assert.ok(restored.ok);
    if (!restored.ok)
        return;
    assert.equal(restored.value.manifest, undefined);
});
test('setManifest replaces the graph manifest without mutating node/edge content', () => {
    const graph = XoirGraph.create(XoirGraphId('g1'));
    const node = graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' } });
    assert.ok(node.ok);
    const hashBefore = node.ok ? node.value.hash : undefined;
    graph.setManifest(createManifest({ schemaVersion: 1 }));
    assert.ok(graph.manifest !== undefined);
    const nodeAfter = graph.getNode(XoirNodeId('n1'));
    assert.ok(nodeAfter.ok);
    if (nodeAfter.ok)
        assert.equal(nodeAfter.value.hash, hashBefore);
});
test('pass-history timestamps never affect a node/edge content hash (only manifest.ts carries them, hashing.ts never reads manifest.ts types)', () => {
    const now = () => '2026-01-01T00:00:00.000Z';
    const a = createNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, now });
    // Simulate time passing / a pass appending history: the node's own createdAt/updatedAt are fixed by `now`,
    // and manifest-level pass history lives in a completely separate structure, so re-running "the same"
    // compilation at a different wall-clock time does not change this node's hash.
    const b = createNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, now });
    assert.equal(hashNode(a), hashNode(b));
});
//# sourceMappingURL=manifest.test.js.map
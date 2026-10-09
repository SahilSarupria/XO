import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { mergeGraphsPreservingProvenance } from '../src/provenance-merge.js';
import { confidenceFromScore } from '../src/confidence.js';
import { createManifest } from '../src/manifest.js';
import { validateGraph } from '../src/validation.js';
import { ContentHash } from '@xo/types';
const now = () => '2026-01-01T00:00:00.000Z';
test('two same-id nodes with identical core content but different sourceRefs are reconciled, not reported as a conflict', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 'The contract term is 24 months', domain: 'contract' },
        sourceRefs: [{ documentPath: 'doc-a.pdf' }],
        now,
    });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 'The contract term is 24 months', domain: 'contract' },
        sourceRefs: [{ documentPath: 'doc-b.pdf' }],
        now,
    });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 0);
    assert.deepEqual(result.value.reconciledNodeIds, [XoirNodeId('n1')]);
    const node = result.value.graph.getNode(XoirNodeId('n1'));
    assert.ok(node.ok);
    if (!node.ok)
        return;
    assert.deepEqual(node.value.metadata.sourceRefs.map((r) => r.documentPath).sort(), ['doc-a.pdf', 'doc-b.pdf']);
});
test('reconciled confidence reflects real corroboration count and the strongest individual score, never a fabricated value', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'concept',
        properties: { definition: 'Acme Corp' },
        sourceRefs: [{ documentPath: 'doc-a.pdf' }],
        confidenceDetail: confidenceFromScore(0.6, { basis: 'stated' }),
        now,
    });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'concept',
        properties: { definition: 'Acme Corp' },
        sourceRefs: [{ documentPath: 'doc-b.pdf' }],
        confidenceDetail: confidenceFromScore(0.85, { basis: 'stated' }),
        now,
    });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    const node = result.value.graph.getNode(XoirNodeId('n1'));
    assert.ok(node.ok);
    if (!node.ok)
        return;
    assert.equal(node.value.metadata.confidenceDetail?.score, 0.85);
    assert.equal(node.value.metadata.confidenceDetail?.corroboration, 2);
    assert.equal(node.value.metadata.confidenceDetail?.basis, 'stated');
    assert.equal(node.value.metadata.confidenceDetail?.calibrated, false);
});
test('duplicate sourceRefs pointing at the identical piece of evidence are deduplicated, not doubled', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, sourceRefs: [{ documentPath: 'doc-a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, sourceRefs: [{ documentPath: 'doc-a.pdf' }], now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    const node = result.value.graph.getNode(XoirNodeId('n1'));
    assert.ok(node.ok);
    if (node.ok)
        assert.equal(node.value.metadata.sourceRefs.length, 1);
});
test('two same-id nodes with genuinely different core content are reported as a real conflict, not silently reconciled', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 'X is compliant', domain: 'tax' }, confidence: 0.9, now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 'X is NOT compliant', domain: 'tax' }, confidence: 0.6, now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 1);
    assert.equal(result.value.reconciledNodeIds.length, 0);
    assert.equal(result.value.conflicts[0].candidates.length, 2);
    const node = result.value.graph.getNode(XoirNodeId('n1'));
    assert.ok(node.ok);
    if (node.ok)
        assert.equal(node.value.properties.statement, 'X is compliant');
});
test('a 3-way conflict where 2 candidates agree and 1 disagrees reconciles the agreeing pair before resolving the conflict, so their combined corroboration is what competes', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 'A', domain: 'd' }, sourceRefs: [{ documentPath: 'x.pdf' }], confidence: 0.5, now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 'A', domain: 'd' }, sourceRefs: [{ documentPath: 'y.pdf' }], confidence: 0.5, now });
    const g3 = XoirGraph.create(XoirGraphId('g3'));
    g3.createAndAddNode({ id: XoirNodeId('n1'), kind: 'fact', properties: { statement: 'B', domain: 'd' }, confidence: 0.6, now });
    const result = mergeGraphsPreservingProvenance([g1, g2, g3], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 1);
    const conflict = result.value.conflicts[0];
    assert.equal(conflict.candidates.length, 2);
    const reconciledA = conflict.candidates.find((c) => c.properties.statement === 'A');
    assert.ok(reconciledA);
    assert.equal(reconciledA.metadata.confidenceDetail?.corroboration, 2);
});
test('edges: same-id edges with identical core content are reconciled with provenance union', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
    g1.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'b' }, now });
    g1.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), sourceRefs: [{ documentPath: 'doc-a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
    g2.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'b' }, now });
    g2.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), sourceRefs: [{ documentPath: 'doc-b.pdf' }], now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.edgeConflicts.length, 0);
    assert.deepEqual(result.value.reconciledEdgeIds, [XoirEdgeId('e1')]);
    const edge = result.value.graph.getEdge('e1');
    assert.ok(edge.ok);
    if (edge.ok)
        assert.equal(edge.value.metadata.sourceRefs.length, 2);
});
test('edges: same-id edges with different core content are a genuine edge conflict', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
    g1.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'b' }, now });
    g1.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), confidence: 0.9, now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
    g2.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'b' }, now });
    g2.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'CONTRADICTS', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), confidence: 0.4, now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.edgeConflicts.length, 1);
    assert.equal(result.value.edgeConflicts[0].candidates.length, 2);
});
test('metadata/subtype are preserved through reconciliation', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', subtype: 'organization', properties: { definition: 'Acme' }, sourceRefs: [{ documentPath: 'a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', subtype: 'organization', properties: { definition: 'Acme' }, sourceRefs: [{ documentPath: 'b.pdf' }], now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    const node = result.value.graph.getNode(XoirNodeId('n1'));
    assert.ok(node.ok);
    if (node.ok)
        assert.equal(node.value.metadata.subtype, 'organization');
});
test('a node with a differing subtype is treated as a genuine conflict, not silently merged', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', subtype: 'organization', properties: { definition: 'Acme' }, now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', subtype: 'product', properties: { definition: 'Acme' }, now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 1);
});
test('manifests from multiple input graphs are unioned deterministically, and a merge of manifest-less graphs stays manifest-less', () => {
    const m1 = createManifest({ schemaVersion: 1, professionTags: ['corporate-law'], sourceManifestRefs: ['src-1'], now });
    const m2 = createManifest({ schemaVersion: 1, professionTags: ['tax-law', 'corporate-law'], sourceManifestRefs: ['src-2'], now });
    const g1 = XoirGraph.create(XoirGraphId('g1'), 1, m1);
    g1.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, now });
    const g2 = XoirGraph.create(XoirGraphId('g2'), 1, m2);
    g2.createAndAddNode({ id: XoirNodeId('n2'), kind: 'concept', properties: { definition: 'y' }, now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.deepEqual(result.value.graph.manifest?.professionTags, ['corporate-law', 'tax-law']);
    assert.deepEqual(result.value.graph.manifest?.sourceManifestRefs, ['src-1', 'src-2']);
    const noManifestResult = mergeGraphsPreservingProvenance([XoirGraph.create(XoirGraphId('a')), XoirGraph.create(XoirGraphId('b'))], XoirGraphId('merged2'), { now });
    assert.ok(noManifestResult.ok);
    if (noManifestResult.ok)
        assert.equal(noManifestResult.value.graph.manifest, undefined);
});
test('pass history from multiple manifests is concatenated and deterministically sorted', () => {
    const m1 = createManifest({
        schemaVersion: 1,
        passHistory: [{ passId: 'extract', passVersion: '1.0.0', inputHash: ContentHash(`sha256:${'a'.repeat(64)}`), outputHash: ContentHash(`sha256:${'b'.repeat(64)}`), timestamp: '2026-01-01T00:00:01.000Z' }],
        now,
    });
    const m2 = createManifest({
        schemaVersion: 1,
        passHistory: [{ passId: 'convert', passVersion: '1.0.0', inputHash: ContentHash(`sha256:${'c'.repeat(64)}`), outputHash: ContentHash(`sha256:${'d'.repeat(64)}`), timestamp: '2026-01-01T00:00:00.000Z' }],
        now,
    });
    const g1 = XoirGraph.create(XoirGraphId('g1'), 1, m1);
    const g2 = XoirGraph.create(XoirGraphId('g2'), 1, m2);
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.deepEqual(result.value.graph.manifest?.passHistory.map((p) => p.passId), ['convert', 'extract']);
});
test('the merged graph passes structural validation', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'b.pdf' }], now });
    const result = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    const report = validateGraph(result.value.graph);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
});
test('merging is deterministic: running the same merge twice produces the same graph content hash', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'b.pdf' }], now });
    const r1 = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    const r2 = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok)
        return;
    assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});
test('merging is order-independent for node/edge content: [g1, g2] and [g2, g1] produce the same content hash', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'a.pdf' }], now });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, sourceRefs: [{ documentPath: 'b.pdf' }], now });
    const r1 = mergeGraphsPreservingProvenance([g1, g2], XoirGraphId('merged'), { now });
    const r2 = mergeGraphsPreservingProvenance([g2, g1], XoirGraphId('merged'), { now });
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok)
        return;
    assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});
test('rejects an empty graph list', () => {
    const result = mergeGraphsPreservingProvenance([], XoirGraphId('merged'));
    assert.equal(result.ok, false);
});
test('a single graph merges into an equivalent copy of itself', () => {
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
    const result = mergeGraphsPreservingProvenance([g1], XoirGraphId('merged'), { now });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.graph.allNodes().length, 1);
    assert.equal(result.value.conflicts.length, 0);
    assert.equal(result.value.reconciledNodeIds.length, 0);
});
//# sourceMappingURL=provenance-merge.test.js.map
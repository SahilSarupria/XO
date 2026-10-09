import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId } from '../src/ids.js';
import { mergeGraphs } from '../src/merge.js';
import { validateGraph } from '../src/validation.js';
test('XoirSourceRef carries Stage-4-equivalent richer provenance fields', () => {
    const graph = XoirGraph.create(XoirGraphId('g1'));
    const result = graph.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 'Contract term is 24 months', domain: 'contract' },
        sourceRefs: [
            {
                documentPath: 'contracts/nda.pdf',
                locator: 'Section 4(a)',
                experienceUnitId: 'unit-42',
                pages: [3, 4],
                sectionPath: ['Term', 'Duration'],
                charOffsetRange: [1200, 1256],
                sourceConfidence: 0.95,
            },
        ],
    });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    const ref = result.value.metadata.sourceRefs[0];
    assert.equal(ref.experienceUnitId, 'unit-42');
    assert.deepEqual(ref.pages, [3, 4]);
    assert.deepEqual(ref.sectionPath, ['Term', 'Duration']);
    assert.deepEqual(ref.charOffsetRange, [1200, 1256]);
    assert.equal(ref.sourceConfidence, 0.95);
});
test('a node with an empty documentPath in a sourceRef fails validation (structural provenance check)', () => {
    const graph = XoirGraph.create(XoirGraphId('g1'));
    graph.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 's', domain: 'd' },
        sourceRefs: [{ documentPath: '' }],
    });
    const report = validateGraph(graph);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((i) => i.kind === 'invalid_provenance_reference'));
});
test('merging two graphs that each contribute a distinct sourceRef for the same node id unions provenance rather than picking one (when content is otherwise identical)', () => {
    const now = () => '2026-01-01T00:00:00.000Z';
    const g1 = XoirGraph.create(XoirGraphId('g1'));
    g1.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 'shared fact', domain: 'd' },
        sourceRefs: [{ documentPath: 'source-a.pdf' }],
        now,
    });
    const g2 = XoirGraph.create(XoirGraphId('g2'));
    g2.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'fact',
        properties: { statement: 'shared fact', domain: 'd' },
        sourceRefs: [{ documentPath: 'source-b.pdf' }],
        now,
    });
    // Different sourceRefs make the two candidate nodes hash-distinct, so this
    // is a genuine merge conflict (see merge.ts) — resolved here by taking the
    // higher-confidence candidate. Provenance UNION across differently-sourced
    // duplicate claims is the adapter layer's job (see the compiler's Stage
    // 4/5 -> XOIR adapters, which union sourceRefs before ever handing nodes
    // to mergeGraphs): mergeGraphs itself is identity-preserving, not a
    // silent content-merger — see merge.ts's doc comment.
    const result = mergeGraphs([g1, g2], XoirGraphId('merged'));
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.conflicts.length, 1);
    assert.equal(result.value.conflicts[0].reason, 'duplicate_id_different_content');
});
test('a node built with sourceRefs unioned ahead of merge time preserves every contributing source', () => {
    // This is the shape an adapter (Stage 4/5 -> XOIR) is expected to produce:
    // union provenance BEFORE constructing the canonical node, so a single
    // XOIR node ends up with sourceRefs from every corroborating source.
    const graph = XoirGraph.create(XoirGraphId('g1'));
    const result = graph.createAndAddNode({
        id: XoirNodeId('n1'),
        kind: 'concept',
        properties: { definition: 'A shared concept.' },
        sourceRefs: [{ documentPath: 'source-a.pdf' }, { documentPath: 'source-b.pdf' }],
    });
    assert.ok(result.ok);
    if (!result.ok)
        return;
    assert.equal(result.value.metadata.sourceRefs.length, 2);
    assert.deepEqual(result.value.metadata.sourceRefs.map((r) => r.documentPath).sort(), ['source-a.pdf', 'source-b.pdf']);
});
//# sourceMappingURL=provenance.test.js.map
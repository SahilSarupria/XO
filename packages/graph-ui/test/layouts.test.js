import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
function chain() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'c', type: 't', label: 'C', position: { x: 0, y: 0 } })
        .upsertEdge({ id: 'e1', type: 'l', source: 'a', target: 'b' })
        .upsertEdge({ id: 'e2', type: 'l', source: 'b', target: 'c' });
}
test('registry ships all seven built-in layouts', () => {
    const layouts = new GraphLayouts();
    for (const kind of ['hierarchical', 'dag', 'tree', 'force-directed', 'circular', 'grid', 'manual']) {
        assert.ok(layouts.has(kind), `missing layout: ${kind}`);
    }
});
test('unknown layout kind throws', () => {
    const layouts = new GraphLayouts();
    assert.throws(() => layouts.compute('nonexistent', chain()));
});
test('register adds a custom layout engine', () => {
    const layouts = new GraphLayouts();
    layouts.register({
        kind: 'custom-diagonal',
        compute: (model) => ({
            kind: 'custom-diagonal',
            positions: model.nodes.map((n, i) => ({ id: n.id, position: { x: i * 50, y: i * 50 } })),
        }),
    });
    assert.ok(layouts.has('custom-diagonal'));
    const result = layouts.compute('custom-diagonal', chain());
    assert.equal(result.positions.length, 3);
});
test('hierarchical layers a->b->c into three distinct rows', () => {
    const layouts = new GraphLayouts();
    const result = layouts.compute('hierarchical', chain());
    const y = new Map(result.positions.map((p) => [p.id, p.position.y]));
    assert.ok(y.get('a') < y.get('b'));
    assert.ok(y.get('b') < y.get('c'));
});
test('dag layout is layered the same way as hierarchical', () => {
    const layouts = new GraphLayouts();
    const result = layouts.compute('dag', chain());
    const y = new Map(result.positions.map((p) => [p.id, p.position.y]));
    assert.ok(y.get('a') < y.get('b') && y.get('b') < y.get('c'));
});
test('tree layout places root above its children', () => {
    const model = GraphModel.empty()
        .upsertNode({ id: 'root', type: 't', label: 'R', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'l', type: 't', label: 'L', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'r', type: 't', label: 'Rr', position: { x: 0, y: 0 } })
        .upsertEdge({ id: 'e1', type: 'l', source: 'root', target: 'l' })
        .upsertEdge({ id: 'e2', type: 'l', source: 'root', target: 'r' });
    const layouts = new GraphLayouts();
    const result = layouts.compute('tree', model);
    const y = new Map(result.positions.map((p) => [p.id, p.position.y]));
    assert.ok(y.get('root') < y.get('l'));
    assert.ok(y.get('root') < y.get('r'));
});
test('grid layout is deterministic and spaces nodes on a grid', () => {
    const layouts = new GraphLayouts();
    const r1 = layouts.compute('grid', chain(), { columns: 2, spacingX: 100, spacingY: 100 });
    const r2 = layouts.compute('grid', chain(), { columns: 2, spacingX: 100, spacingY: 100 });
    assert.deepEqual(r1.positions, r2.positions, 'grid layout must be deterministic');
    const posA = r1.positions.find((p) => p.id === 'a').position;
    const posB = r1.positions.find((p) => p.id === 'b').position;
    assert.equal(posB.x - posA.x, 100);
});
test('circular layout places nodes on a circle of the requested radius', () => {
    const layouts = new GraphLayouts();
    const result = layouts.compute('circular', chain(), { radius: 200 });
    for (const p of result.positions) {
        const dist = Math.sqrt(p.position.x ** 2 + p.position.y ** 2);
        assert.ok(Math.abs(dist - 200) < 1e-6);
    }
});
test('manual layout is a pass-through of existing positions', () => {
    const model = GraphModel.empty().upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 42, y: 7 } });
    const layouts = new GraphLayouts();
    const result = layouts.compute('manual', model);
    assert.deepEqual(result.positions[0].position, { x: 42, y: 7 });
});
test('force-directed layout is deterministic given the same input', () => {
    const layouts = new GraphLayouts();
    const r1 = layouts.compute('force-directed', chain(), { iterations: 20 });
    const r2 = layouts.compute('force-directed', chain(), { iterations: 20 });
    assert.deepEqual(r1.positions, r2.positions);
});
test('apply() writes computed positions back onto the model', () => {
    const layouts = new GraphLayouts();
    const model = layouts.apply('grid', chain(), { columns: 3, spacingX: 100, spacingY: 100 });
    assert.deepEqual(model.getNode('b').position, { x: 100, y: 0 });
});
//# sourceMappingURL=layouts.test.js.map
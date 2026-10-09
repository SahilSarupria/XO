import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { MarqueeSelection } from '../src/interaction/MarqueeSelection.js';
import { LassoSelection } from '../src/interaction/LassoSelection.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'inside', type: 't', label: 'I', position: { x: 10, y: 10 }, size: { width: 20, height: 20 } })
        .upsertNode({ id: 'outside', type: 't', label: 'O', position: { x: 1000, y: 1000 }, size: { width: 20, height: 20 } });
}
test('MarqueeSelection tracks rect across begin/update/end', () => {
    const m0 = MarqueeSelection.idle();
    assert.ok(!m0.isActive);
    const m1 = m0.begin({ x: 0, y: 0 });
    const m2 = m1.update({ x: 100, y: 50 });
    assert.deepEqual(m2.rect, { x: 0, y: 0, width: 100, height: 50 });
    assert.ok(!m0.isActive, 'original must be untouched');
    assert.ok(m2.end().isActive === false);
});
test('MarqueeSelection.matchingNodeIds / toSelection intersect the model', () => {
    const marquee = MarqueeSelection.idle().begin({ x: 0, y: 0 }).update({ x: 100, y: 100 });
    const model = sample();
    assert.deepEqual(marquee.matchingNodeIds(model), ['inside']);
    assert.ok(marquee.toSelection(model).hasNode('inside'));
});
test('MarqueeSelection returns no matches while idle', () => {
    assert.deepEqual(MarqueeSelection.idle().matchingNodeIds(sample()), []);
});
test('LassoSelection accumulates points and selects nodes inside the polygon', () => {
    const model = sample();
    const lasso = LassoSelection.idle()
        .begin({ x: 0, y: 0 })
        .addPoint({ x: 100, y: 0 })
        .addPoint({ x: 100, y: 100 })
        .addPoint({ x: 0, y: 100 });
    const matches = lasso.matchingNodeIds(model);
    assert.deepEqual(matches, ['inside']);
    assert.ok(lasso.toSelection(model).hasNode('inside'));
});
test('LassoSelection needs at least 3 points to select anything', () => {
    const lasso = LassoSelection.idle().begin({ x: 0, y: 0 }).addPoint({ x: 10, y: 10 });
    assert.deepEqual(lasso.matchingNodeIds(sample()), []);
});
test('LassoSelection.addPoint is a no-op once ended', () => {
    const lasso = LassoSelection.idle().begin({ x: 0, y: 0 }).end();
    assert.equal(lasso.addPoint({ x: 1, y: 1 }), lasso);
});
//# sourceMappingURL=marquee-lasso.test.js.map
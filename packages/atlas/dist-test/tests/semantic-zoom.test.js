import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticZoomRegistry } from '../src/semantic-zoom.js';
describe('SemanticZoomRegistry', () => {
    it('is invisible before appearsAt and fully visible at or after fullyVisibleAt', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'memory-graph', appearsAt: 5, fullyVisibleAt: 6 });
        assert.equal(registry.at(4).find((s) => s.id === 'memory-graph')?.visibility, 0);
        assert.equal(registry.at(5).find((s) => s.id === 'memory-graph')?.visibility, 0);
        assert.equal(registry.at(6).find((s) => s.id === 'memory-graph')?.visibility, 1);
        assert.equal(registry.at(9).find((s) => s.id === 'memory-graph')?.visibility, 1);
    });
    it('interpolates smoothly between appearsAt and fullyVisibleAt — nothing pops', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'x', appearsAt: 0, fullyVisibleAt: 10 });
        const midpoint = registry.at(5).find((s) => s.id === 'x').visibility;
        assert.ok(Math.abs(midpoint - 0.5) < 1e-9);
        const quarter = registry.at(2.5).find((s) => s.id === 'x').visibility;
        assert.ok(Math.abs(quarter - 0.25) < 1e-9);
    });
    it('treats a zero-span rule as a hard threshold rather than dividing by zero', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'threshold', appearsAt: 3, fullyVisibleAt: 3 });
        assert.equal(registry.at(2.999).find((s) => s.id === 'threshold')?.visibility, 0);
        assert.equal(registry.at(3).find((s) => s.id === 'threshold')?.visibility, 1);
    });
    it('visible() excludes anything with zero visibility and sorts most-visible first', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'near', appearsAt: 0, fullyVisibleAt: 1 });
        registry.register({ id: 'far', appearsAt: 5, fullyVisibleAt: 10 });
        const visible = registry.visible(0.5);
        assert.deepEqual(visible.map((s) => s.id), ['near']);
    });
    it('carries opaque data through without inspecting it', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'a', appearsAt: 0, fullyVisibleAt: 1, data: { label: 'hello' } });
        assert.equal(registry.at(1).find((s) => s.id === 'a')?.data?.label, 'hello');
    });
    it('unregister and clear remove rules', () => {
        const registry = new SemanticZoomRegistry();
        registry.register({ id: 'a', appearsAt: 0, fullyVisibleAt: 1 });
        registry.register({ id: 'b', appearsAt: 0, fullyVisibleAt: 1 });
        registry.unregister('a');
        assert.equal(registry.at(1).length, 1);
        registry.clear();
        assert.equal(registry.at(1).length, 0);
    });
});
//# sourceMappingURL=semantic-zoom.test.js.map
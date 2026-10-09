import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorld } from '../src/projection.js';
import { MarketplaceIntent } from '../src/intent.js';
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js';
describe('MarketplaceIntent', () => {
    it('targets the position of the highest-scoring resolved candidate by default', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const intent = new MarketplaceIntent(world);
        intent.update([
            { xoId: 'signal', score: 0.3 },
            { xoId: 'forge', score: 0.9 },
        ]);
        assert.equal(intent.topXOId(), 'forge');
        assert.deepEqual(intent.target(), world.positions.get('forge'));
    });
    it('silently drops candidates for unknown XOs rather than throwing', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const intent = new MarketplaceIntent(world);
        intent.update([{ xoId: 'does-not-exist', score: 1 }]);
        assert.equal(intent.target(), null);
    });
    it('returns null before any candidates have been offered', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const intent = new MarketplaceIntent(world);
        assert.equal(intent.target(), null);
        assert.equal(intent.topXOId(), null);
    });
    it('clear() resets targeting', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const intent = new MarketplaceIntent(world);
        intent.update([{ xoId: 'signal', score: 1 }]);
        intent.clear();
        assert.equal(intent.target(), null);
    });
});
//# sourceMappingURL=intent.test.js.map
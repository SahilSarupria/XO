import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialMemory } from '../src/spatial-memory.js';
function snapshot(overrides = {}) {
    return { position: { x: 0, y: 0 }, altitude: 2, focusId: null, timestamp: 0, ...overrides };
}
describe('SpatialMemory', () => {
    it('remembers a place and recalls it by id', () => {
        const memory = new SpatialMemory();
        const id = memory.remember(snapshot({ altitude: 4 }), 'forge interior');
        const recalled = memory.recall(id);
        assert.equal(recalled?.snapshot.altitude, 4);
        assert.equal(recalled?.label, 'forge interior');
    });
    it('recalls the most recently created place when multiple share a label', () => {
        const memory = new SpatialMemory();
        memory.remember(snapshot({ altitude: 1 }), 'favorite', 100);
        memory.remember(snapshot({ altitude: 9 }), 'favorite', 200);
        const recalled = memory.recall('favorite');
        assert.equal(recalled?.snapshot.altitude, 9);
    });
    it('returns null recalling something that was never remembered', () => {
        const memory = new SpatialMemory();
        assert.equal(memory.recall('nothing-here'), null);
    });
    it('forget() removes a remembered place', () => {
        const memory = new SpatialMemory();
        const id = memory.remember(snapshot());
        memory.forget(id);
        assert.equal(memory.recall(id), null);
    });
    it('tracks visited entities independent of remembered places', () => {
        const memory = new SpatialMemory();
        memory.markVisited('forge');
        memory.markVisited('signal');
        memory.markVisited('forge'); // idempotent
        assert.equal(memory.hasVisited('forge'), true);
        assert.equal(memory.hasVisited('atlas'), false);
        assert.equal(memory.exploredCount(), 2);
    });
    it('round-trips through export()/import() for cross-session persistence', () => {
        const memory = new SpatialMemory();
        memory.remember(snapshot({ altitude: 3 }), 'somewhere');
        memory.markVisited('forge');
        const exported = memory.export();
        const restored = new SpatialMemory();
        restored.import(exported);
        assert.equal(restored.recall('somewhere')?.snapshot.altitude, 3);
        assert.equal(restored.hasVisited('forge'), true);
    });
    it('list() orders places most-recent-first', () => {
        const memory = new SpatialMemory();
        memory.remember(snapshot(), 'first', 100);
        memory.remember(snapshot(), 'second', 200);
        const [mostRecent] = memory.list();
        assert.equal(mostRecent?.label, 'second');
    });
});
//# sourceMappingURL=spatial-memory.test.js.map
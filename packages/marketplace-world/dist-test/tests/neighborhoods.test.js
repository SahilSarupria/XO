import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorld } from '../src/projection.js';
import { MarketplaceNeighborhoods } from '../src/neighborhoods.js';
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js';
describe('MarketplaceNeighborhoods', () => {
    it('near() returns other XOs closest-first', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const neighborhoods = new MarketplaceNeighborhoods(world);
        const near = neighborhoods.near('signal', 4);
        assert.equal(near.length, 4);
        assert.ok(!near.some((xo) => xo.id === 'signal'));
    });
    it('ecosystemMembers() returns every XO in a declared community', () => {
        const world = projectWorld({
            xos: [
                { id: 'a', name: 'A', kind: 'x', capabilityIds: [] },
                { id: 'b', name: 'B', kind: 'x', capabilityIds: [] },
                { id: 'c', name: 'C', kind: 'x', capabilityIds: [] },
            ],
            communities: [{ id: 'guild', label: 'Guild', memberIds: ['a', 'b'] }],
        });
        const neighborhoods = new MarketplaceNeighborhoods(world);
        const members = neighborhoods.ecosystemMembers('guild').map((x) => x.id).sort();
        assert.deepEqual(members, ['a', 'b']);
    });
    it('capabilitiesSurrounding() unions capabilities of nearby XOs', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const neighborhoods = new MarketplaceNeighborhoods(world);
        const capabilities = neighborhoods.capabilitiesSurrounding('signal', 100); // whole world
        const ids = capabilities.map((c) => c.id).sort();
        assert.ok(ids.includes('automations')); // from relay
        assert.ok(ids.includes('code')); // from forge
    });
    it('relatedWorkflows() follows relationships, not spatial distance', () => {
        const world = projectWorld({
            xos: [
                { id: 'a', name: 'A', kind: 'x', capabilityIds: [], workflowIds: ['review-flow'] },
                { id: 'b', name: 'B', kind: 'x', capabilityIds: [] },
            ],
            relationships: [{ fromId: 'a', toId: 'b', kind: 'dependsOn' }],
        });
        const neighborhoods = new MarketplaceNeighborhoods(world);
        const workflows = neighborhoods.relatedWorkflows('b');
        assert.deepEqual(workflows.map((w) => w.id), ['review-flow']);
    });
    it('nearestTo() finds the closest XO to an arbitrary point', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const neighborhoods = new MarketplaceNeighborhoods(world);
        const signalPos = world.positions.get('signal');
        const nearest = neighborhoods.nearestTo({ x: signalPos.x + 0.5, y: signalPos.y + 0.5 });
        assert.equal(nearest?.id, 'signal');
    });
});
//# sourceMappingURL=neighborhoods.test.js.map
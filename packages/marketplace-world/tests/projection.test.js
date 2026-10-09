import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorld } from '../src/projection.js';
import { SAMPLE_GRAPH } from '../fixtures/sample-graph.js';
describe('projectWorld', () => {
    it('produces one XOEntity per source XO, preserving stated fields', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        assert.equal(world.xos.size, 5);
        const signal = world.xos.get('signal');
        assert.equal(signal.name, 'SIGNAL');
        assert.equal(signal.kind, 'Research intelligence');
        assert.equal(signal.status, 'Listening');
        assert.deepEqual(signal.capabilityIds, ['memory', 'research', 'synthesis']);
        assert.equal(signal.installState, 'available'); // default applied
    });
    it('synthesizes minimal capability entries for ids referenced but not cataloged', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        assert.equal(world.capabilities.get('research')?.label, 'research');
        assert.equal(world.capabilities.size, new Set(SAMPLE_GRAPH.xos.flatMap((x) => x.capabilityIds)).size);
    });
    it('carries explicit relationships through, deduped and normalized', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        const explicit = world.relationships.filter((r) => r.kind === 'dependsOn');
        assert.equal(explicit.length, 6);
        // fromId/toId are always sorted lexicographically for a stable key
        for (const r of explicit)
            assert.ok(r.fromId < r.toId);
    });
    it('derives implicit sharesCapability relationships from overlapping capabilities', () => {
        const world = projectWorld(SAMPLE_GRAPH);
        // no two XOs in the sample graph share a capability id, so none should appear
        const shared = world.relationships.filter((r) => r.kind === 'sharesCapability');
        assert.equal(shared.length, 0);
        const withOverlap = projectWorld({
            xos: [
                { id: 'a', name: 'A', kind: 'x', capabilityIds: ['search'] },
                { id: 'b', name: 'B', kind: 'x', capabilityIds: ['search'] },
                { id: 'c', name: 'C', kind: 'x', capabilityIds: ['other'] },
            ],
        });
        const derived = withOverlap.relationships.filter((r) => r.kind === 'sharesCapability');
        assert.deepEqual(derived.map((r) => [r.fromId, r.toId]), [['a', 'b']]);
    });
    it('derives implicit communityLink relationships from community membership', () => {
        const world = projectWorld({
            xos: [
                { id: 'a', name: 'A', kind: 'x', capabilityIds: [] },
                { id: 'b', name: 'B', kind: 'x', capabilityIds: [] },
            ],
            communities: [{ id: 'guild', label: 'Guild', memberIds: ['a', 'b'] }],
        });
        const derived = world.relationships.filter((r) => r.kind === 'communityLink');
        assert.deepEqual(derived.map((r) => [r.fromId, r.toId]), [['a', 'b']]);
    });
    it('every XO ends up with a computed position inside the configured area', () => {
        const world = projectWorld(SAMPLE_GRAPH, { area: { width: 100, height: 100 } });
        for (const id of world.xos.keys()) {
            const p = world.positions.get(id);
            assert.ok(p.x >= 0 && p.x <= 100, `x out of range: ${p.x}`);
            assert.ok(p.y >= 0 && p.y <= 100, `y out of range: ${p.y}`);
        }
    });
    it('directly connected XOs end up closer together than to an unrelated isolated XO', () => {
        const world = projectWorld({
            xos: [
                { id: 'a', name: 'A', kind: 'x', capabilityIds: [] },
                { id: 'b', name: 'B', kind: 'x', capabilityIds: [] },
                { id: 'isolated', name: 'Isolated', kind: 'x', capabilityIds: [] },
            ],
            relationships: [{ fromId: 'a', toId: 'b', kind: 'dependsOn' }],
        });
        const pa = world.positions.get('a');
        const pb = world.positions.get('b');
        const pi = world.positions.get('isolated');
        const dAB = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        const dAI = Math.hypot(pa.x - pi.x, pa.y - pi.y);
        assert.ok(dAB < dAI, `expected connected pair closer: dAB=${dAB} dAI=${dAI}`);
    });
});
//# sourceMappingURL=projection.test.js.map
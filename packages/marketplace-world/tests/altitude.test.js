import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketplaceAltitudeModel, MARKETPLACE_ALTITUDE_LEVELS } from '../src/altitude.js';
describe('marketplace altitude model', () => {
    it('defines exactly the eight discussed levels, ecosystem to execution', () => {
        const model = createMarketplaceAltitudeModel();
        assert.equal(model.min, 0);
        assert.equal(model.max, 7);
        assert.deepEqual(model.all().map((l) => l.id), ['ecosystem', 'community', 'experience', 'capability', 'workflow', 'reasoning', 'memory', 'execution']);
    });
    it('every level carries a description of what becomes available, not a UI requirement', () => {
        for (const level of MARKETPLACE_ALTITUDE_LEVELS) {
            assert.ok(level.description && level.description.length > 0, `${level.id} missing a description`);
        }
    });
    it('zoomTo("experience") resolves to the correct order via the model', () => {
        const model = createMarketplaceAltitudeModel();
        assert.equal(model.byId('experience')?.order, 2);
        assert.equal(model.byId('execution')?.order, 7);
    });
});
//# sourceMappingURL=altitude.test.js.map
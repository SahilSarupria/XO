import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AltitudeModel } from '../src/altitude.js';
const marketplaceLevels = [
    { id: 'ecosystem', order: 0, label: 'Ecosystem' },
    { id: 'community', order: 1, label: 'Communities' },
    { id: 'experience', order: 2, label: 'Experiences' },
    { id: 'capability', order: 3, label: 'Capabilities' },
    { id: 'workflow', order: 4, label: 'Workflow' },
    { id: 'reasoning', order: 5, label: 'Reasoning' },
    { id: 'memory', order: 6, label: 'Memory' },
    { id: 'execution', order: 7, label: 'Execution' },
];
describe('AltitudeModel', () => {
    it('is fully configurable — levels are not hardcoded', () => {
        const debuggerLevels = [
            { id: 'process', order: 0, label: 'Process' },
            { id: 'stack-frame', order: 1, label: 'Stack Frame' },
            { id: 'variable', order: 2, label: 'Variable' },
        ];
        const model = new AltitudeModel(debuggerLevels);
        assert.equal(model.min, 0);
        assert.equal(model.max, 2);
        assert.equal(model.byId('stack-frame')?.label, 'Stack Frame');
    });
    it('rejects duplicate orders and duplicate ids', () => {
        assert.throws(() => new AltitudeModel([{ id: 'a', order: 0, label: 'A' }, { id: 'b', order: 0, label: 'B' }]));
        assert.throws(() => new AltitudeModel([{ id: 'a', order: 0, label: 'A' }, { id: 'a', order: 1, label: 'A2' }]));
    });
    it('requires at least one level', () => {
        assert.throws(() => new AltitudeModel([]));
    });
    it('reports min and max from the configured levels, regardless of input order', () => {
        const shuffled = [...marketplaceLevels].reverse();
        const model = new AltitudeModel(shuffled);
        assert.equal(model.min, 0);
        assert.equal(model.max, 7);
    });
    it('clamps out-of-range altitudes', () => {
        const model = new AltitudeModel(marketplaceLevels);
        assert.equal(model.clamp(-5), 0);
        assert.equal(model.clamp(50), 7);
        assert.equal(model.clamp(3), 3);
    });
    it('finds the nearest defined level to a continuous altitude', () => {
        const model = new AltitudeModel(marketplaceLevels);
        assert.equal(model.nearest(2.4).id, 'experience');
        assert.equal(model.nearest(2.6).id, 'capability');
    });
    it('deeper() and shallower() walk the ordering correctly', () => {
        const model = new AltitudeModel(marketplaceLevels);
        assert.equal(model.deeper(2)?.id, 'capability');
        assert.equal(model.shallower(2)?.id, 'community');
        assert.equal(model.deeper(7), undefined);
        assert.equal(model.shallower(0), undefined);
    });
});
//# sourceMappingURL=altitude.test.js.map
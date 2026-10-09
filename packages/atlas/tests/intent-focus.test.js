import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IntentFocus } from '../src/intent-focus.js';
describe('IntentFocus', () => {
    it('reports the highest-scoring candidate as top()', () => {
        const focus = new IntentFocus();
        focus.update([
            { id: 'signal', position: { x: 1, y: 1 }, score: 0.4 },
            { id: 'forge', position: { x: 2, y: 2 }, score: 0.9 },
        ]);
        assert.equal(focus.top()?.id, 'forge');
    });
    it('target() in "top" mode returns the top candidate position', () => {
        const focus = new IntentFocus({ blend: 'top' });
        focus.update([
            { id: 'a', position: { x: 1, y: 1 }, score: 0.2 },
            { id: 'b', position: { x: 9, y: 9 }, score: 0.8 },
        ]);
        assert.deepEqual(focus.target(), { x: 9, y: 9 });
    });
    it('target() in "weighted-centroid" mode blends toward stronger candidates', () => {
        const focus = new IntentFocus({ blend: 'weighted-centroid' });
        focus.update([
            { id: 'a', position: { x: 0, y: 0 }, score: 1 },
            { id: 'b', position: { x: 10, y: 0 }, score: 1 },
        ]);
        // equal scores -> exact midpoint
        assert.deepEqual(focus.target(), { x: 5, y: 0 });
    });
    it('returns null when nothing has been offered', () => {
        const focus = new IntentFocus();
        assert.equal(focus.top(), null);
        assert.equal(focus.target(), null);
    });
    it('decays scores over time when decayPerSecond is set', () => {
        let now = 0;
        const focus = new IntentFocus({ decayPerSecond: 0.5 }, now);
        focus.update([{ id: 'a', position: { x: 0, y: 0 }, score: 1 }], now);
        now += 1000; // 1 second later, 50% decay
        const top = focus.top(now);
        assert.ok(top && Math.abs(top.score - 0.5) < 1e-9, `expected ~0.5, got ${top?.score}`);
    });
    it('fully decays to null once score reaches zero', () => {
        let now = 0;
        const focus = new IntentFocus({ decayPerSecond: 1 }, now);
        focus.update([{ id: 'a', position: { x: 0, y: 0 }, score: 1 }], now);
        now += 5000; // far past full decay
        assert.equal(focus.top(now), null);
    });
    it('does not decay when decayPerSecond is 0 (the default)', () => {
        let now = 0;
        const focus = new IntentFocus({}, now);
        focus.update([{ id: 'a', position: { x: 0, y: 0 }, score: 0.7 }], now);
        now += 10_000;
        assert.equal(focus.top(now)?.score, 0.7);
    });
    it('clamps out-of-range scores into [0, 1]', () => {
        const focus = new IntentFocus();
        focus.update([{ id: 'a', position: { x: 0, y: 0 }, score: 5 }]);
        assert.equal(focus.top()?.score, 1);
    });
    it('clear() removes all candidates', () => {
        const focus = new IntentFocus();
        focus.update([{ id: 'a', position: { x: 0, y: 0 }, score: 1 }]);
        focus.clear();
        assert.equal(focus.top(), null);
    });
});
//# sourceMappingURL=intent-focus.test.js.map
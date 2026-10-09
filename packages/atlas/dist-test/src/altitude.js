import { clamp } from './types.js';
export class AltitudeModel {
    levels;
    constructor(levels) {
        if (levels.length === 0) {
            throw new Error('AltitudeModel requires at least one level.');
        }
        const seenOrders = new Set();
        const seenIds = new Set();
        for (const level of levels) {
            if (seenOrders.has(level.order)) {
                throw new Error(`AltitudeModel: duplicate order ${level.order}.`);
            }
            if (seenIds.has(level.id)) {
                throw new Error(`AltitudeModel: duplicate id "${level.id}".`);
            }
            seenOrders.add(level.order);
            seenIds.add(level.id);
        }
        this.levels = [...levels].sort((a, b) => a.order - b.order);
    }
    /** The shallowest defined altitude. */
    get min() {
        return this.levels[0].order;
    }
    /** The deepest defined altitude. */
    get max() {
        return this.levels[this.levels.length - 1].order;
    }
    /** All levels, shallow to deep. */
    all() {
        return this.levels;
    }
    byId(id) {
        return this.levels.find((level) => level.id === id);
    }
    byOrder(order) {
        return this.levels.find((level) => level.order === order);
    }
    /** Constrain a continuous altitude value to the defined range. */
    clamp(order) {
        return clamp(order, this.min, this.max);
    }
    /** The nearest defined level to a continuous altitude value. */
    nearest(order) {
        let best = this.levels[0];
        let bestDistance = Math.abs(best.order - order);
        for (const level of this.levels) {
            const d = Math.abs(level.order - order);
            if (d < bestDistance) {
                best = level;
                bestDistance = d;
            }
        }
        return best;
    }
    /** The next level deeper than the given altitude, if any. */
    deeper(order) {
        return this.levels.find((level) => level.order > order);
    }
    /** The next level shallower than the given altitude, if any. */
    shallower(order) {
        let result;
        for (const level of this.levels) {
            if (level.order < order)
                result = level;
            else
                break;
        }
        return result;
    }
}
//# sourceMappingURL=altitude.js.map
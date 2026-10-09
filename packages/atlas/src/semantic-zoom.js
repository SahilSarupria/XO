import { clamp01 } from './types.js';
export class SemanticZoomRegistry {
    rules = new Map();
    register(rule) {
        this.rules.set(rule.id, rule);
    }
    unregister(id) {
        this.rules.delete(id);
    }
    clear() {
        this.rules.clear();
    }
    /** Every registered rule's emergence state at a given altitude. */
    at(altitude) {
        const states = [];
        for (const rule of this.rules.values()) {
            states.push({ id: rule.id, visibility: emergence(rule, altitude), data: rule.data });
        }
        return states;
    }
    /** Only what has begun to emerge (visibility > 0), most visible first. */
    visible(altitude) {
        return this.at(altitude)
            .filter((state) => state.visibility > 0)
            .sort((a, b) => b.visibility - a.visibility);
    }
}
function emergence(rule, altitude) {
    const span = rule.fullyVisibleAt - rule.appearsAt;
    if (span <= 0) {
        return altitude >= rule.appearsAt ? 1 : 0;
    }
    return clamp01((altitude - rule.appearsAt) / span);
}
//# sourceMappingURL=semantic-zoom.js.map
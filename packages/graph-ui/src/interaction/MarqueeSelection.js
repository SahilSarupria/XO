import { GraphSelection } from '../selection/GraphSelection.js';
const IDLE = { phase: 'idle', origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } };
function rectFrom(origin, current) {
    return {
        x: Math.min(origin.x, current.x),
        y: Math.min(origin.y, current.y),
        width: Math.abs(current.x - origin.x),
        height: Math.abs(current.y - origin.y),
    };
}
/**
 * Deterministic rectangular ("marquee") box-selection state machine. The
 * resulting rect is intersection-tested against the model with the same
 * semantics as `GraphSelection.fromBox`.
 */
export class MarqueeSelection {
    state;
    constructor(state) {
        this.state = state;
    }
    static idle() {
        return new MarqueeSelection(IDLE);
    }
    begin(origin) {
        return new MarqueeSelection({ phase: 'active', origin, current: origin });
    }
    update(current) {
        if (this.state.phase !== 'active')
            return this;
        return new MarqueeSelection({ ...this.state, current });
    }
    end() {
        return MarqueeSelection.idle();
    }
    get isActive() {
        return this.state.phase === 'active';
    }
    get rect() {
        return rectFrom(this.state.origin, this.state.current);
    }
    /** Nodes intersecting the current marquee rect, computed against `model`. */
    matchingNodeIds(model) {
        if (this.state.phase !== 'active')
            return [];
        return [...GraphSelection.fromBox(this.rect, model).state.nodeIds];
    }
    toSelection(model) {
        return GraphSelection.fromBox(this.rect, model);
    }
}
//# sourceMappingURL=MarqueeSelection.js.map
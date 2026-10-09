import { GraphInteraction } from './GraphInteraction.js';
const NONE = {};
/**
 * Deterministic keyboard-focus tracker for accessibility navigation: which
 * single node currently "has focus" (analogous to DOM focus, but with zero
 * DOM dependency), plus a stable tab order derived from the model.
 */
export class FocusManager {
    state;
    constructor(state) {
        this.state = state;
    }
    static none() {
        return new FocusManager(NONE);
    }
    focus(nodeId) {
        if (this.state.focusedNodeId === nodeId)
            return this;
        return new FocusManager({ focusedNodeId: nodeId });
    }
    blur() {
        if (this.state.focusedNodeId === undefined)
            return this;
        return FocusManager.none();
    }
    get isFocused() {
        return this.state.focusedNodeId !== undefined;
    }
    /** Stable accessibility tab order: the model's deterministic insertion order. */
    static tabOrder(model) {
        return model.nodes.map((n) => n.id);
    }
    /** Moves focus to the next/previous node in tab order, wrapping at both ends. */
    focusNext(model, reverse = false) {
        const order = FocusManager.tabOrder(model);
        if (order.length === 0)
            return this;
        if (this.state.focusedNodeId === undefined) {
            return this.focus(reverse ? order[order.length - 1] : order[0]);
        }
        const index = order.indexOf(this.state.focusedNodeId);
        const nextIndex = index === -1 ? 0 : (index + (reverse ? -1 : 1) + order.length) % order.length;
        return this.focus(order[nextIndex]);
    }
    /** Moves focus spatially (arrow-key navigation), reusing GraphInteraction's directional search. Stays put if there's no neighbor in that direction. */
    focusDirectional(model, direction) {
        if (this.state.focusedNodeId === undefined)
            return this.focusNext(model);
        const next = GraphInteraction.findNeighborInDirection(this.state.focusedNodeId, direction, model);
        return next ? this.focus(next) : this;
    }
}
//# sourceMappingURL=FocusManager.js.map
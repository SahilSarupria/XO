/**
 * Minimal, dependency-free event bus for pointer/keyboard interaction,
 * plus spatial-nearest-neighbor keyboard navigation. Adapters (DOM, React
 * Flow, ...) translate native browser events into calls on `emit`; host
 * applications subscribe with `on`.
 */
export class GraphInteraction {
    listeners = new Map();
    nodeDragEnabled;
    constructor(options = {}) {
        this.nodeDragEnabled = options.nodeDragEnabled ?? false;
    }
    on(name, listener) {
        if (!this.listeners.has(name))
            this.listeners.set(name, new Set());
        this.listeners.get(name).add(listener);
        return () => this.off(name, listener);
    }
    off(name, listener) {
        this.listeners.get(name)?.delete(listener);
    }
    emit(name, event) {
        for (const listener of this.listeners.get(name) ?? [])
            listener(event);
    }
    setNodeDragEnabled(enabled) {
        this.nodeDragEnabled = enabled;
    }
    /**
     * Given the currently focused node, find the neighbor most closely
     * aligned with `direction` (by position, not graph topology) — this is
     * what powers arrow-key navigation across the canvas.
     */
    static findNeighborInDirection(fromNodeId, direction, model) {
        const from = model.getNode(fromNodeId);
        if (!from)
            return undefined;
        let best;
        for (const node of model.nodes) {
            if (node.id === fromNodeId)
                continue;
            const dx = node.position.x - from.position.x;
            const dy = node.position.y - from.position.y;
            const aligned = (direction === 'right' && dx > 0 && Math.abs(dy) <= Math.abs(dx)) ||
                (direction === 'left' && dx < 0 && Math.abs(dy) <= Math.abs(dx)) ||
                (direction === 'down' && dy > 0 && Math.abs(dx) <= Math.abs(dy)) ||
                (direction === 'up' && dy < 0 && Math.abs(dx) <= Math.abs(dy));
            if (!aligned)
                continue;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (!best || distance < best.distance)
                best = { id: node.id, distance };
        }
        return best?.id;
    }
}
//# sourceMappingURL=GraphInteraction.js.map
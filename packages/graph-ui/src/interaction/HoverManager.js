const NONE = { kind: 'none' };
/** Deterministic single-target hover tracker (one thing hovered at a time, like a real pointer). */
export class HoverManager {
    state;
    constructor(state) {
        this.state = state;
    }
    static none() {
        return new HoverManager(NONE);
    }
    hoverNode(id, nowMs) {
        if (this.state.kind === 'node' && this.state.id === id)
            return this;
        return new HoverManager({ kind: 'node', id, enteredAtMs: nowMs });
    }
    hoverEdge(id, nowMs) {
        if (this.state.kind === 'edge' && this.state.id === id)
            return this;
        return new HoverManager({ kind: 'edge', id, enteredAtMs: nowMs });
    }
    clear() {
        if (this.state.kind === 'none')
            return this;
        return HoverManager.none();
    }
    get hoverDurationMs() {
        const enteredAt = this.state.enteredAtMs ?? 0;
        return (nowMs) => (this.state.kind === 'none' ? 0 : Math.max(0, nowMs - enteredAt));
    }
}
//# sourceMappingURL=HoverManager.js.map
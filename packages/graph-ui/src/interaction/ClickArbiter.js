const DEFAULTS = {
    doubleClickWindowMs: 300,
    doubleClickMaxDistance: 8,
    longPressThresholdMs: 500,
};
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
/**
 * Deterministic, immutable single/double-click and long-press arbitration.
 * There are no timers here — the host calls `pointerDown`/`pointerUp` with
 * explicit timestamps (from its own clock/render loop) and gets back both
 * the arbitration result and the next `ClickArbiter` instance to use going
 * forward, the same "returns a new instance" shape as the other state
 * machines in this module.
 */
export class ClickArbiter {
    state;
    constructor(state) {
        this.state = state;
    }
    static create(options = {}) {
        return new ClickArbiter({ options: { ...DEFAULTS, ...options } });
    }
    pointerDown(event) {
        return new ClickArbiter({ ...this.state, pendingDown: event });
    }
    /** Resolves the click arbitrated by the down/up pair; call this on pointer up. */
    pointerUp(upPoint, upTimestampMs) {
        const { options, pendingDown: down, lastClick } = this.state;
        if (!down)
            return { arbiter: this, result: undefined };
        const heldMs = upTimestampMs - down.timestampMs;
        if (heldMs >= options.longPressThresholdMs && distance(down.point, upPoint) <= options.doubleClickMaxDistance) {
            return {
                arbiter: new ClickArbiter({ options, lastClick: undefined, pendingDown: undefined }),
                result: { kind: 'longPress', target: down },
            };
        }
        const isDouble = !!lastClick &&
            lastClick.id === down.id &&
            lastClick.kind === down.kind &&
            down.timestampMs - lastClick.timestampMs <= options.doubleClickWindowMs &&
            distance(lastClick.point, down.point) <= options.doubleClickMaxDistance;
        if (isDouble) {
            return {
                arbiter: new ClickArbiter({ options, lastClick: undefined, pendingDown: undefined }),
                result: { kind: 'doubleClick', target: down },
            };
        }
        return {
            arbiter: new ClickArbiter({ options, lastClick: down, pendingDown: undefined }),
            result: { kind: 'click', target: down },
        };
    }
    reset() {
        return new ClickArbiter({ options: this.state.options, lastClick: undefined, pendingDown: undefined });
    }
}
//# sourceMappingURL=ClickArbiter.js.map
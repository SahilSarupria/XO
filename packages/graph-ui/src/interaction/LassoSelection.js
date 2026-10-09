import { GraphSelection } from '../selection/GraphSelection.js';
const IDLE = { phase: 'idle', points: [] };
/** Even-odd point-in-polygon test. */
function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const pi = polygon[i];
        const pj = polygon[j];
        const intersects = pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
        if (intersects)
            inside = !inside;
    }
    return inside;
}
/**
 * Deterministic free-form ("lasso") selection state machine: accumulates a
 * polyline of points, then selects nodes whose center falls inside the
 * closed polygon (even-odd rule).
 */
export class LassoSelection {
    state;
    constructor(state) {
        this.state = state;
    }
    static idle() {
        return new LassoSelection(IDLE);
    }
    begin(origin) {
        return new LassoSelection({ phase: 'active', points: [origin] });
    }
    addPoint(point) {
        if (this.state.phase !== 'active')
            return this;
        return new LassoSelection({ ...this.state, points: [...this.state.points, point] });
    }
    end() {
        return LassoSelection.idle();
    }
    get isActive() {
        return this.state.phase === 'active';
    }
    matchingNodeIds(model) {
        if (this.state.points.length < 3)
            return [];
        const ids = [];
        for (const node of model.nodes) {
            const size = node.size ?? { width: 120, height: 40 };
            const center = { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
            if (pointInPolygon(center, this.state.points))
                ids.push(node.id);
        }
        return ids;
    }
    toSelection(model) {
        return GraphSelection.empty().selectNodes(this.matchingNodeIds(model));
    }
}
//# sourceMappingURL=LassoSelection.js.map
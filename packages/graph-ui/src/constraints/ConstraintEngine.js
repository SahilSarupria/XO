function applyAxisLock(proposed, constraint, original) {
    if (!constraint)
        return proposed;
    if (constraint.lockedPosition)
        return constraint.lockedPosition;
    switch (constraint.lockedAxis) {
        case 'x':
            return { x: original.x, y: proposed.y };
        case 'y':
            return { x: proposed.x, y: original.y };
        case 'both':
            return original;
        default:
            return proposed;
    }
}
function applyGridSnap(point, gridSize) {
    if (!gridSize || gridSize <= 0)
        return point;
    return { x: Math.round(point.x / gridSize) * gridSize, y: Math.round(point.y / gridSize) * gridSize };
}
/**
 * Immutable registry of per-node declarative constraints
 * (locked axis/position, snap groups, minimum spacing, parent/child
 * relationships, per-node grid size) plus the pure resolution function
 * that reconciles a batch of proposed moves against them. Alignment and
 * distribution are expressed as one-shot rules rather than persistent
 * per-node constraints, since they describe a relationship between a set
 * of nodes at the moment they're invoked.
 */
export class ConstraintEngine {
    byNode;
    constructor(byNode) {
        this.byNode = byNode;
    }
    static empty() {
        return new ConstraintEngine(new Map());
    }
    setConstraint(nodeId, constraint) {
        const next = new Map(this.byNode);
        next.set(nodeId, constraint);
        return new ConstraintEngine(next);
    }
    clearConstraint(nodeId) {
        if (!this.byNode.has(nodeId))
            return this;
        const next = new Map(this.byNode);
        next.delete(nodeId);
        return new ConstraintEngine(next);
    }
    getConstraint(nodeId) {
        return this.byNode.get(nodeId);
    }
    /** Resolves a batch of proposed node moves against every registered constraint: axis/position locks, per-node grid snapping, and — for nodes sharing a snapGroupId — a minimum-spacing pass along the dominant axis of movement. */
    resolve(model, proposedPositions) {
        const resolved = new Map();
        for (const [nodeId, proposed] of proposedPositions) {
            const node = model.getNode(nodeId);
            if (!node)
                continue;
            const constraint = this.byNode.get(nodeId);
            let point = applyAxisLock(proposed, constraint, node.position);
            point = applyGridSnap(point, constraint?.gridSize);
            resolved.set(nodeId, point);
        }
        this.enforceMinSpacing(model, resolved);
        return resolved;
    }
    enforceMinSpacing(model, resolved) {
        const groups = new Map();
        for (const [nodeId, constraint] of this.byNode) {
            if (!constraint.snapGroupId || !constraint.minSpacing)
                continue;
            if (!groups.has(constraint.snapGroupId))
                groups.set(constraint.snapGroupId, []);
            groups.get(constraint.snapGroupId).push(nodeId);
        }
        for (const ids of groups.values()) {
            const minSpacing = this.byNode.get(ids[0])?.minSpacing ?? 0;
            const ordered = [...ids].sort((a, b) => {
                const pa = resolved.get(a) ?? model.getNode(a).position;
                const pb = resolved.get(b) ?? model.getNode(b).position;
                return pa.x - pb.x;
            });
            for (let i = 1; i < ordered.length; i++) {
                const prevId = ordered[i - 1];
                const id = ordered[i];
                const prev = resolved.get(prevId) ?? model.getNode(prevId).position;
                const current = resolved.get(id) ?? model.getNode(id).position;
                if (current.x - prev.x < minSpacing) {
                    resolved.set(id, { x: prev.x + minSpacing, y: current.y });
                }
            }
        }
    }
    /** Aligns the given nodes' positions along one axis to their shared mean — a pure computation returning new positions, not a mutation. */
    static align(model, rule) {
        const positions = rule.nodeIds.map((id) => model.getNode(id)?.position).filter((p) => !!p);
        if (positions.length === 0)
            return new Map();
        const mean = rule.axis === 'x'
            ? positions.reduce((s, p) => s + p.x, 0) / positions.length
            : positions.reduce((s, p) => s + p.y, 0) / positions.length;
        const result = new Map();
        for (const id of rule.nodeIds) {
            const p = model.getNode(id)?.position;
            if (!p)
                continue;
            result.set(id, rule.axis === 'x' ? { x: mean, y: p.y } : { x: p.x, y: mean });
        }
        return result;
    }
    /** Distributes the given nodes evenly along one axis between their current min and max. */
    static distribute(model, rule) {
        const withPositions = rule.nodeIds.map((id) => ({ id, p: model.getNode(id)?.position })).filter((e) => !!e.p);
        if (withPositions.length < 3) {
            return new Map(withPositions.map((e) => [e.id, e.p]));
        }
        const sorted = [...withPositions].sort((a, b) => (rule.axis === 'x' ? a.p.x - b.p.x : a.p.y - b.p.y));
        const first = sorted[0].p;
        const last = sorted[sorted.length - 1].p;
        const min = rule.axis === 'x' ? first.x : first.y;
        const max = rule.axis === 'x' ? last.x : last.y;
        const step = (max - min) / (sorted.length - 1);
        const result = new Map();
        sorted.forEach((entry, i) => {
            const value = min + step * i;
            result.set(entry.id, rule.axis === 'x' ? { x: value, y: entry.p.y } : { x: entry.p.x, y: value });
        });
        return result;
    }
    /** Applies a resolved position map back onto a model, returning a new model. */
    static applyPositions(model, positions) {
        let next = model;
        for (const [id, position] of positions) {
            const node = next.getNode(id);
            if (node)
                next = next.upsertNode({ ...node, position });
        }
        return next;
    }
}
//# sourceMappingURL=ConstraintEngine.js.map
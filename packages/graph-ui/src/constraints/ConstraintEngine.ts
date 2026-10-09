import type { GraphModel } from '../model/GraphModel.js';
import type { NodeId, Point } from '../model/types.js';

export type LockedAxis = 'x' | 'y' | 'both' | 'none';

export interface AlignmentRule {
  readonly kind: 'align';
  readonly axis: 'x' | 'y';
  readonly nodeIds: readonly NodeId[];
}

export interface DistributionRule {
  readonly kind: 'distribute';
  readonly axis: 'x' | 'y';
  readonly nodeIds: readonly NodeId[];
}

export interface NodeConstraint {
  readonly lockedAxis?: LockedAxis;
  readonly lockedPosition?: Point;
  readonly snapGroupId?: string;
  readonly minSpacing?: number;
  readonly parentId?: NodeId;
  readonly childIds?: readonly NodeId[];
  readonly gridSize?: number;
}

export interface ConstraintViolation {
  readonly nodeId: NodeId;
  readonly reason: string;
}

function applyAxisLock(proposed: Point, constraint: NodeConstraint | undefined, original: Point): Point {
  if (!constraint) return proposed;
  if (constraint.lockedPosition) return constraint.lockedPosition;
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

function applyGridSnap(point: Point, gridSize: number | undefined): Point {
  if (!gridSize || gridSize <= 0) return point;
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
  private constructor(private readonly byNode: ReadonlyMap<NodeId, NodeConstraint>) {}

  static empty(): ConstraintEngine {
    return new ConstraintEngine(new Map());
  }

  setConstraint(nodeId: NodeId, constraint: NodeConstraint): ConstraintEngine {
    const next = new Map(this.byNode);
    next.set(nodeId, constraint);
    return new ConstraintEngine(next);
  }

  clearConstraint(nodeId: NodeId): ConstraintEngine {
    if (!this.byNode.has(nodeId)) return this;
    const next = new Map(this.byNode);
    next.delete(nodeId);
    return new ConstraintEngine(next);
  }

  getConstraint(nodeId: NodeId): NodeConstraint | undefined {
    return this.byNode.get(nodeId);
  }

  /** Resolves a batch of proposed node moves against every registered constraint: axis/position locks, per-node grid snapping, and — for nodes sharing a snapGroupId — a minimum-spacing pass along the dominant axis of movement. */
  resolve(model: GraphModel, proposedPositions: ReadonlyMap<NodeId, Point>): Map<NodeId, Point> {
    const resolved = new Map<NodeId, Point>();
    for (const [nodeId, proposed] of proposedPositions) {
      const node = model.getNode(nodeId);
      if (!node) continue;
      const constraint = this.byNode.get(nodeId);
      let point = applyAxisLock(proposed, constraint, node.position);
      point = applyGridSnap(point, constraint?.gridSize);
      resolved.set(nodeId, point);
    }
    this.enforceMinSpacing(model, resolved);
    return resolved;
  }

  private enforceMinSpacing(model: GraphModel, resolved: Map<NodeId, Point>): void {
    const groups = new Map<string, NodeId[]>();
    for (const [nodeId, constraint] of this.byNode) {
      if (!constraint.snapGroupId || !constraint.minSpacing) continue;
      if (!groups.has(constraint.snapGroupId)) groups.set(constraint.snapGroupId, []);
      groups.get(constraint.snapGroupId)!.push(nodeId);
    }
    for (const ids of groups.values()) {
      const minSpacing = this.byNode.get(ids[0]!)?.minSpacing ?? 0;
      const ordered = [...ids].sort((a, b) => {
        const pa = resolved.get(a) ?? model.getNode(a)!.position;
        const pb = resolved.get(b) ?? model.getNode(b)!.position;
        return pa.x - pb.x;
      });
      for (let i = 1; i < ordered.length; i++) {
        const prevId = ordered[i - 1]!;
        const id = ordered[i]!;
        const prev = resolved.get(prevId) ?? model.getNode(prevId)!.position;
        const current = resolved.get(id) ?? model.getNode(id)!.position;
        if (current.x - prev.x < minSpacing) {
          resolved.set(id, { x: prev.x + minSpacing, y: current.y });
        }
      }
    }
  }

  /** Aligns the given nodes' positions along one axis to their shared mean — a pure computation returning new positions, not a mutation. */
  static align(model: GraphModel, rule: AlignmentRule): Map<NodeId, Point> {
    const positions = rule.nodeIds.map((id) => model.getNode(id)?.position).filter((p): p is Point => !!p);
    if (positions.length === 0) return new Map();
    const mean =
      rule.axis === 'x'
        ? positions.reduce((s, p) => s + p.x, 0) / positions.length
        : positions.reduce((s, p) => s + p.y, 0) / positions.length;
    const result = new Map<NodeId, Point>();
    for (const id of rule.nodeIds) {
      const p = model.getNode(id)?.position;
      if (!p) continue;
      result.set(id, rule.axis === 'x' ? { x: mean, y: p.y } : { x: p.x, y: mean });
    }
    return result;
  }

  /** Distributes the given nodes evenly along one axis between their current min and max. */
  static distribute(model: GraphModel, rule: DistributionRule): Map<NodeId, Point> {
    const withPositions = rule.nodeIds.map((id) => ({ id, p: model.getNode(id)?.position })).filter((e): e is { id: NodeId; p: Point } => !!e.p);
    if (withPositions.length < 3) {
      return new Map(withPositions.map((e) => [e.id, e.p]));
    }
    const sorted = [...withPositions].sort((a, b) => (rule.axis === 'x' ? a.p.x - b.p.x : a.p.y - b.p.y));
    const first = sorted[0]!.p;
    const last = sorted[sorted.length - 1]!.p;
    const min = rule.axis === 'x' ? first.x : first.y;
    const max = rule.axis === 'x' ? last.x : last.y;
    const step = (max - min) / (sorted.length - 1);
    const result = new Map<NodeId, Point>();
    sorted.forEach((entry, i) => {
      const value = min + step * i;
      result.set(entry.id, rule.axis === 'x' ? { x: value, y: entry.p.y } : { x: entry.p.x, y: value });
    });
    return result;
  }

  /** Applies a resolved position map back onto a model, returning a new model. */
  static applyPositions(model: GraphModel, positions: ReadonlyMap<NodeId, Point>): GraphModel {
    let next = model;
    for (const [id, position] of positions) {
      const node = next.getNode(id);
      if (node) next = next.upsertNode({ ...node, position });
    }
    return next;
  }
}

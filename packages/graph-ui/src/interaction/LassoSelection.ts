import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import type { NodeId, Point } from '../model/types.js';

export type LassoPhase = 'idle' | 'active';

export interface LassoState {
  readonly phase: LassoPhase;
  readonly points: readonly Point[];
}

const IDLE: LassoState = { phase: 'idle', points: [] };

/** Even-odd point-in-polygon test. */
function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects = pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Deterministic free-form ("lasso") selection state machine: accumulates a
 * polyline of points, then selects nodes whose center falls inside the
 * closed polygon (even-odd rule).
 */
export class LassoSelection {
  private constructor(readonly state: LassoState) {}

  static idle(): LassoSelection {
    return new LassoSelection(IDLE);
  }

  begin(origin: Point): LassoSelection {
    return new LassoSelection({ phase: 'active', points: [origin] });
  }

  addPoint(point: Point): LassoSelection {
    if (this.state.phase !== 'active') return this;
    return new LassoSelection({ ...this.state, points: [...this.state.points, point] });
  }

  end(): LassoSelection {
    return LassoSelection.idle();
  }

  get isActive(): boolean {
    return this.state.phase === 'active';
  }

  matchingNodeIds(model: GraphModel): readonly NodeId[] {
    if (this.state.points.length < 3) return [];
    const ids: NodeId[] = [];
    for (const node of model.nodes) {
      const size = node.size ?? { width: 120, height: 40 };
      const center = { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
      if (pointInPolygon(center, this.state.points)) ids.push(node.id);
    }
    return ids;
  }

  toSelection(model: GraphModel): GraphSelection {
    return GraphSelection.empty().selectNodes(this.matchingNodeIds(model));
  }
}

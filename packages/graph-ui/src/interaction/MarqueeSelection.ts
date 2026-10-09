import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import type { NodeId, Point, Rect } from '../model/types.js';

export type MarqueePhase = 'idle' | 'active';

export interface MarqueeState {
  readonly phase: MarqueePhase;
  readonly origin: Point;
  readonly current: Point;
}

const IDLE: MarqueeState = { phase: 'idle', origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } };

function rectFrom(origin: Point, current: Point): Rect {
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
  private constructor(readonly state: MarqueeState) {}

  static idle(): MarqueeSelection {
    return new MarqueeSelection(IDLE);
  }

  begin(origin: Point): MarqueeSelection {
    return new MarqueeSelection({ phase: 'active', origin, current: origin });
  }

  update(current: Point): MarqueeSelection {
    if (this.state.phase !== 'active') return this;
    return new MarqueeSelection({ ...this.state, current });
  }

  end(): MarqueeSelection {
    return MarqueeSelection.idle();
  }

  get isActive(): boolean {
    return this.state.phase === 'active';
  }

  get rect(): Rect {
    return rectFrom(this.state.origin, this.state.current);
  }

  /** Nodes intersecting the current marquee rect, computed against `model`. */
  matchingNodeIds(model: GraphModel): readonly NodeId[] {
    if (this.state.phase !== 'active') return [];
    return [...GraphSelection.fromBox(this.rect, model).state.nodeIds];
  }

  toSelection(model: GraphModel): GraphSelection {
    return GraphSelection.fromBox(this.rect, model);
  }
}

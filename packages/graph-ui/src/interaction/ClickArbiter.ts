import type { EdgeId, NodeId, Point } from '../model/types.js';

export type ClickTargetKind = 'node' | 'edge' | 'canvas';

export interface PointerDownEvent {
  readonly kind: ClickTargetKind;
  readonly id?: NodeId | EdgeId;
  readonly point: Point;
  readonly timestampMs: number;
}

export type ArbitratedClick =
  | { readonly kind: 'click'; readonly target: PointerDownEvent }
  | { readonly kind: 'doubleClick'; readonly target: PointerDownEvent }
  | { readonly kind: 'longPress'; readonly target: PointerDownEvent };

export interface ClickArbiterOptions {
  readonly doubleClickWindowMs?: number;
  readonly doubleClickMaxDistance?: number;
  readonly longPressThresholdMs?: number;
}

export interface PointerUpResult {
  readonly arbiter: ClickArbiter;
  readonly result: ArbitratedClick | undefined;
}

const DEFAULTS: Required<ClickArbiterOptions> = {
  doubleClickWindowMs: 300,
  doubleClickMaxDistance: 8,
  longPressThresholdMs: 500,
};

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface ArbiterState {
  readonly options: Required<ClickArbiterOptions>;
  readonly lastClick?: PointerDownEvent | undefined;
  readonly pendingDown?: PointerDownEvent | undefined;
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
  private constructor(private readonly state: ArbiterState) {}

  static create(options: ClickArbiterOptions = {}): ClickArbiter {
    return new ClickArbiter({ options: { ...DEFAULTS, ...options } });
  }

  pointerDown(event: PointerDownEvent): ClickArbiter {
    return new ClickArbiter({ ...this.state, pendingDown: event });
  }

  /** Resolves the click arbitrated by the down/up pair; call this on pointer up. */
  pointerUp(upPoint: Point, upTimestampMs: number): PointerUpResult {
    const { options, pendingDown: down, lastClick } = this.state;
    if (!down) return { arbiter: this, result: undefined };

    const heldMs = upTimestampMs - down.timestampMs;
    if (heldMs >= options.longPressThresholdMs && distance(down.point, upPoint) <= options.doubleClickMaxDistance) {
      return {
        arbiter: new ClickArbiter({ options, lastClick: undefined, pendingDown: undefined }),
        result: { kind: 'longPress', target: down },
      };
    }

    const isDouble =
      !!lastClick &&
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

  reset(): ClickArbiter {
    return new ClickArbiter({ options: this.state.options, lastClick: undefined, pendingDown: undefined });
  }
}

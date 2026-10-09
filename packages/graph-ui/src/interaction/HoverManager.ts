import type { EdgeId, NodeId } from '../model/types.js';

export type HoverTargetKind = 'node' | 'edge' | 'none';

export interface HoverState {
  readonly kind: HoverTargetKind;
  readonly id?: NodeId | EdgeId;
  readonly enteredAtMs?: number;
}

const NONE: HoverState = { kind: 'none' };

/** Deterministic single-target hover tracker (one thing hovered at a time, like a real pointer). */
export class HoverManager {
  private constructor(readonly state: HoverState) {}

  static none(): HoverManager {
    return new HoverManager(NONE);
  }

  hoverNode(id: NodeId, nowMs: number): HoverManager {
    if (this.state.kind === 'node' && this.state.id === id) return this;
    return new HoverManager({ kind: 'node', id, enteredAtMs: nowMs });
  }

  hoverEdge(id: EdgeId, nowMs: number): HoverManager {
    if (this.state.kind === 'edge' && this.state.id === id) return this;
    return new HoverManager({ kind: 'edge', id, enteredAtMs: nowMs });
  }

  clear(): HoverManager {
    if (this.state.kind === 'none') return this;
    return HoverManager.none();
  }

  get hoverDurationMs(): (nowMs: number) => number {
    const enteredAt = this.state.enteredAtMs ?? 0;
    return (nowMs: number) => (this.state.kind === 'none' ? 0 : Math.max(0, nowMs - enteredAt));
  }
}

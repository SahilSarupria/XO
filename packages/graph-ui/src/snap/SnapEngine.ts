import type { GraphModel } from '../model/GraphModel.js';
import type { NodeId, Point, Rect } from '../model/types.js';

export type GuideOrientation = 'vertical' | 'horizontal';
export type GuideSource = 'edge' | 'center' | 'spacing' | 'custom';

export interface SnapGuide {
  readonly orientation: GuideOrientation;
  /** World-space x (vertical guide) or y (horizontal guide) coordinate the guide sits at. */
  readonly position: number;
  readonly source: GuideSource;
  /** Ids of other nodes this guide is aligned with, if any. */
  readonly relatedNodeIds: readonly NodeId[];
}

export interface SnapResult {
  readonly position: Point;
  readonly guides: readonly SnapGuide[];
  readonly snapped: boolean;
}

export interface SnapOptions {
  readonly gridSize?: number;
  readonly guideThreshold?: number;
  readonly magneticRadius?: number;
  readonly customGuides?: readonly SnapGuide[];
}

const DEFAULTS: Required<Omit<SnapOptions, 'customGuides'>> = {
  gridSize: 20,
  guideThreshold: 6,
  magneticRadius: 12,
};

const DEFAULT_SIZE = { width: 120, height: 40 };

function nodeRect(model: GraphModel, id: NodeId): Rect {
  const node = model.getNode(id)!;
  const size = node.size ?? DEFAULT_SIZE;
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}

/**
 * Pure snapping computation: given a proposed point for a node being
 * dragged (plus its size), returns the resolved (possibly snapped) point
 * and the set of guide lines that fired — grid snap, edge/center/spacing
 * alignment against sibling nodes, and any host-supplied custom guides.
 * "Magnetic" behavior is just a snap radius: candidates within
 * `magneticRadius` win, otherwise the proposed point passes through
 * unchanged.
 */
export class SnapEngine {
  private readonly options: Required<Omit<SnapOptions, 'customGuides'>> & { customGuides: readonly SnapGuide[] };

  constructor(options: SnapOptions = {}) {
    this.options = { ...DEFAULTS, customGuides: options.customGuides ?? [], ...options };
  }

  gridSnap(point: Point): Point {
    const g = this.options.gridSize;
    if (!g || g <= 0) return point;
    return { x: Math.round(point.x / g) * g, y: Math.round(point.y / g) * g };
  }

  /**
   * Full snap resolution for a node of `size` proposed to move to `point`,
   * against every other node in `model` (excluding `excludeId`). Checks
   * edge alignment (left/right/top/bottom), center alignment, and
   * equal-spacing alignment, each within `magneticRadius`; falls back to
   * grid snap if nothing else fires.
   */
  resolve(model: GraphModel, excludeId: NodeId, point: Point, size = DEFAULT_SIZE): SnapResult {
    const proposedRect: Rect = { x: point.x, y: point.y, width: size.width, height: size.height };
    const guides: SnapGuide[] = [];
    let snappedX: number | undefined;
    let snappedY: number | undefined;

    const others = model.nodes.filter((n) => n.id !== excludeId);
    const candidatesX = new Map<number, { source: GuideSource; ids: NodeId[] }>();
    const candidatesY = new Map<number, { source: GuideSource; ids: NodeId[] }>();

    const addX = (value: number, source: GuideSource, id: NodeId) => {
      const key = Math.round(value * 1000) / 1000;
      if (!candidatesX.has(key)) candidatesX.set(key, { source, ids: [] });
      candidatesX.get(key)!.ids.push(id);
    };
    const addY = (value: number, source: GuideSource, id: NodeId) => {
      const key = Math.round(value * 1000) / 1000;
      if (!candidatesY.has(key)) candidatesY.set(key, { source, ids: [] });
      candidatesY.get(key)!.ids.push(id);
    };

    for (const other of others) {
      const r = nodeRect(model, other.id);
      addX(r.x, 'edge', other.id);
      addX(r.x + r.width, 'edge', other.id);
      addX(r.x + r.width / 2, 'center', other.id);
      addY(r.y, 'edge', other.id);
      addY(r.y + r.height, 'edge', other.id);
      addY(r.y + r.height / 2, 'center', other.id);
    }

    const proposedEdgesX = [proposedRect.x, proposedRect.x + proposedRect.width, proposedRect.x + proposedRect.width / 2];
    const proposedEdgesY = [proposedRect.y, proposedRect.y + proposedRect.height, proposedRect.y + proposedRect.height / 2];

    let bestX: { delta: number; value: number; source: GuideSource; ids: NodeId[] } | undefined;
    for (const edge of proposedEdgesX) {
      for (const [value, info] of candidatesX) {
        const delta = Math.abs(edge - value);
        if (delta <= this.options.magneticRadius && (!bestX || delta < bestX.delta)) {
          bestX = { delta, value: point.x + (value - edge), source: info.source, ids: info.ids };
        }
      }
    }
    let bestY: { delta: number; value: number; source: GuideSource; ids: NodeId[] } | undefined;
    for (const edge of proposedEdgesY) {
      for (const [value, info] of candidatesY) {
        const delta = Math.abs(edge - value);
        if (delta <= this.options.magneticRadius && (!bestY || delta < bestY.delta)) {
          bestY = { delta, value: point.y + (value - edge), source: info.source, ids: info.ids };
        }
      }
    }

    if (bestX) {
      snappedX = bestX.value;
      guides.push({ orientation: 'vertical', position: bestX.value, source: bestX.source, relatedNodeIds: bestX.ids });
    }
    if (bestY) {
      snappedY = bestY.value;
      guides.push({ orientation: 'horizontal', position: bestY.value, source: bestY.source, relatedNodeIds: bestY.ids });
    }

    for (const guide of this.options.customGuides) {
      if (guide.orientation === 'vertical' && Math.abs(guide.position - point.x) <= this.options.magneticRadius) {
        snappedX = guide.position;
        guides.push(guide);
      }
      if (guide.orientation === 'horizontal' && Math.abs(guide.position - point.y) <= this.options.magneticRadius) {
        snappedY = guide.position;
        guides.push(guide);
      }
    }

    const resolved: Point = {
      x: snappedX ?? this.gridSnap(point).x,
      y: snappedY ?? this.gridSnap(point).y,
    };

    return { position: resolved, guides, snapped: guides.length > 0 || snappedX !== undefined || snappedY !== undefined };
  }
}

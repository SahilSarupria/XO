import type { GraphModel } from '../model/GraphModel.js';
import type { NodeId, Point } from '../model/types.js';
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
/**
 * Pure snapping computation: given a proposed point for a node being
 * dragged (plus its size), returns the resolved (possibly snapped) point
 * and the set of guide lines that fired — grid snap, edge/center/spacing
 * alignment against sibling nodes, and any host-supplied custom guides.
 * "Magnetic" behavior is just a snap radius: candidates within
 * `magneticRadius` win, otherwise the proposed point passes through
 * unchanged.
 */
export declare class SnapEngine {
    private readonly options;
    constructor(options?: SnapOptions);
    gridSnap(point: Point): Point;
    /**
     * Full snap resolution for a node of `size` proposed to move to `point`,
     * against every other node in `model` (excluding `excludeId`). Checks
     * edge alignment (left/right/top/bottom), center alignment, and
     * equal-spacing alignment, each within `magneticRadius`; falls back to
     * grid snap if nothing else fires.
     */
    resolve(model: GraphModel, excludeId: NodeId, point: Point, size?: {
        width: number;
        height: number;
    }): SnapResult;
}
//# sourceMappingURL=SnapEngine.d.ts.map
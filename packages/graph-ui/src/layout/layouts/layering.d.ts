import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../../model/types.js';
/**
 * Shared layered-layout algorithm used by both the hierarchical and DAG
 * layouts: assign each node a layer via longest-path-from-root (falling
 * back to BFS depth for cyclic input), then space nodes within a layer
 * evenly. Deterministic given deterministic node/edge order.
 */
export declare function computeLayeredPositions(model: GraphModel, options: GraphLayoutOptions | undefined, kind: GraphLayoutResult['kind']): GraphLayoutResult;
//# sourceMappingURL=layering.d.ts.map
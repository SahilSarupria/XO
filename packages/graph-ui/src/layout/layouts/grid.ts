import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';

export const gridLayout: LayoutEngine = {
  kind: 'grid',
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    const spacingX = options?.spacingX ?? 180;
    const spacingY = options?.spacingY ?? 120;
    const columns = options?.columns ?? Math.max(1, Math.ceil(Math.sqrt(model.nodeCount)));
    const positions = model.nodes.map((node, i) => ({
      id: node.id,
      position: { x: (i % columns) * spacingX, y: Math.floor(i / columns) * spacingY },
    }));
    return { kind: 'grid', positions };
  },
};

import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';

export const circularLayout: LayoutEngine = {
  kind: 'circular',
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    const n = model.nodeCount;
    const radius = options?.radius ?? Math.max(120, n * 24);
    const positions = model.nodes.map((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, n);
      return { id: node.id, position: { x: radius * Math.cos(angle), y: radius * Math.sin(angle) } };
    });
    return { kind: 'circular', positions };
  },
};

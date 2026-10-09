import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutResult } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';

/** Pass-through layout: keeps each node's already-assigned position. */
export const manualLayout: LayoutEngine = {
  kind: 'manual',
  compute(model: GraphModel): GraphLayoutResult {
    const positions = model.nodes.map((node) => ({ id: node.id, position: node.position }));
    return { kind: 'manual', positions };
  },
};

import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';
import { computeLayeredPositions } from './layering.js';

export const hierarchicalLayout: LayoutEngine = {
  kind: 'hierarchical',
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    return computeLayeredPositions(model, options, 'hierarchical');
  },
};

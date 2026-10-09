import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';
import { computeLayeredPositions } from './layering.js';

/** Same layered algorithm as hierarchical; kept distinct so callers can pick
 * a layout by the semantics of their data (arbitrary hierarchy vs. a DAG). */
export const dagLayout: LayoutEngine = {
  kind: 'dag',
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    return computeLayeredPositions(model, options, 'dag');
  },
};

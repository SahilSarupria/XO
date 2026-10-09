import type { GraphModel } from '../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../model/types.js';

export interface LayoutEngine {
  readonly kind: GraphLayoutResult['kind'] | string;
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult;
}

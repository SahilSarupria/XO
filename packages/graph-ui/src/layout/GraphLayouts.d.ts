import type { GraphModel } from '../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../model/types.js';
import type { LayoutEngine } from './types.js';
/**
 * Registry of pluggable layout engines. Ships with the seven built-in
 * layouts; consumers can register additional engines with `register`.
 */
export declare class GraphLayouts {
    private readonly engines;
    constructor();
    register(engine: LayoutEngine): this;
    has(kind: string): boolean;
    get availableKinds(): readonly string[];
    compute(kind: string, model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult;
    /** Apply a computed layout's positions back onto a model, returning a new model. */
    apply(kind: string, model: GraphModel, options?: GraphLayoutOptions): GraphModel;
}
//# sourceMappingURL=GraphLayouts.d.ts.map
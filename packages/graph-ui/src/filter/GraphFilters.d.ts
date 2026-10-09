import { GraphModel } from '../model/GraphModel.js';
import type { GraphFilterState } from '../model/types.js';
/**
 * GraphFilters computes a *derived* visible GraphModel from a base model +
 * filter predicates. The base model is never mutated; filtering is a pure
 * projection applied at render/query time.
 */
export declare class GraphFilters {
    readonly state: GraphFilterState;
    constructor(state?: GraphFilterState);
    static empty(): GraphFilters;
    withNodeTypes(types: readonly string[]): GraphFilters;
    withEdgeTypes(types: readonly string[]): GraphFilters;
    withLabelQuery(query: string): GraphFilters;
    withMetadataPredicate(predicate: NonNullable<GraphFilterState['metadataPredicate']>): GraphFilters;
    withHiddenNodes(ids: readonly string[]): GraphFilters;
    withHiddenEdges(ids: readonly string[]): GraphFilters;
    withCollapsedGroups(ids: readonly string[]): GraphFilters;
    clear(): GraphFilters;
    private nodePasses;
    /** Apply this filter set to a model, returning a new, smaller GraphModel. */
    apply(model: GraphModel): GraphModel;
}
//# sourceMappingURL=GraphFilters.d.ts.map
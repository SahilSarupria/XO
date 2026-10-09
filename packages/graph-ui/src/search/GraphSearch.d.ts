import type { GraphModel } from '../model/GraphModel.js';
import type { GraphSearchMatch, GraphSearchResultState } from '../model/types.js';
/**
 * Search over the current model by label, id, or metadata. Immutable —
 * `run` returns a fresh GraphSearch positioned at the first match.
 */
export declare class GraphSearch {
    readonly result: GraphSearchResultState;
    constructor(result?: GraphSearchResultState);
    static run(query: string, model: GraphModel): GraphSearch;
    get activeMatch(): GraphSearchMatch | undefined;
    next(): GraphSearch;
    previous(): GraphSearch;
    clear(): GraphSearch;
}
//# sourceMappingURL=GraphSearch.d.ts.map
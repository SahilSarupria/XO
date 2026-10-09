import { computeLayeredPositions } from './layering.js';
/** Same layered algorithm as hierarchical; kept distinct so callers can pick
 * a layout by the semantics of their data (arbitrary hierarchy vs. a DAG). */
export const dagLayout = {
    kind: 'dag',
    compute(model, options) {
        return computeLayeredPositions(model, options, 'dag');
    },
};
//# sourceMappingURL=dag.js.map
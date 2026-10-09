import { computeLayeredPositions } from './layering.js';
export const hierarchicalLayout = {
    kind: 'hierarchical',
    compute(model, options) {
        return computeLayeredPositions(model, options, 'hierarchical');
    },
};
//# sourceMappingURL=hierarchical.js.map
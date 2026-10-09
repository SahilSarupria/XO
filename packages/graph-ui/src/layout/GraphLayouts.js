import { hierarchicalLayout } from './layouts/hierarchical.js';
import { dagLayout } from './layouts/dag.js';
import { treeLayout } from './layouts/tree.js';
import { forceDirectedLayout } from './layouts/force.js';
import { circularLayout } from './layouts/circular.js';
import { gridLayout } from './layouts/grid.js';
import { manualLayout } from './layouts/manual.js';
/**
 * Registry of pluggable layout engines. Ships with the seven built-in
 * layouts; consumers can register additional engines with `register`.
 */
export class GraphLayouts {
    engines = new Map();
    constructor() {
        for (const engine of [
            hierarchicalLayout,
            dagLayout,
            treeLayout,
            forceDirectedLayout,
            circularLayout,
            gridLayout,
            manualLayout,
        ]) {
            this.engines.set(engine.kind, engine);
        }
    }
    register(engine) {
        this.engines.set(engine.kind, engine);
        return this;
    }
    has(kind) {
        return this.engines.has(kind);
    }
    get availableKinds() {
        return [...this.engines.keys()];
    }
    compute(kind, model, options) {
        const engine = this.engines.get(kind);
        if (!engine) {
            throw new Error(`Unknown layout kind: "${kind}". Registered kinds: ${this.availableKinds.join(', ')}`);
        }
        return engine.compute(model, options);
    }
    /** Apply a computed layout's positions back onto a model, returning a new model. */
    apply(kind, model, options) {
        const result = this.compute(kind, model, options);
        let next = model;
        for (const { id, position } of result.positions) {
            const node = next.getNode(id);
            if (node)
                next = next.upsertNode({ ...node, position });
        }
        return next;
    }
}
//# sourceMappingURL=GraphLayouts.js.map
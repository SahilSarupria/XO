import type { GraphModel } from '../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult } from '../model/types.js';
import type { LayoutEngine } from './types.js';
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
  private readonly engines = new Map<string, LayoutEngine>();

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

  register(engine: LayoutEngine): this {
    this.engines.set(engine.kind, engine);
    return this;
  }

  has(kind: string): boolean {
    return this.engines.has(kind);
  }

  get availableKinds(): readonly string[] {
    return [...this.engines.keys()];
  }

  compute(kind: string, model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    const engine = this.engines.get(kind);
    if (!engine) {
      throw new Error(`Unknown layout kind: "${kind}". Registered kinds: ${this.availableKinds.join(', ')}`);
    }
    return engine.compute(model, options);
  }

  /** Apply a computed layout's positions back onto a model, returning a new model. */
  apply(kind: string, model: GraphModel, options?: GraphLayoutOptions): GraphModel {
    const result = this.compute(kind, model, options);
    let next = model;
    for (const { id, position } of result.positions) {
      const node = next.getNode(id);
      if (node) next = next.upsertNode({ ...node, position });
    }
    return next;
  }
}

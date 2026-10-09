import type { GraphModel } from '../model/GraphModel.js';
/**
 * A GraphAdapter is a pure function object that converts some
 * domain-specific source shape into a generic GraphModel. graph-ui ships
 * one adapter per XO subsystem graph shape (knowledge, capability, intent,
 * workflow, permission, execution, dependency) — but every adapter's
 * `toGraphModel` is a pure conversion with zero imports from the compiler,
 * runtime, studio, registry, or marketplace packages. Callers own mapping
 * their real domain objects into the documented source shape; graph-ui
 * never needs to know those real types exist.
 *
 * Adapters intentionally do NOT run layout — they only place nodes at
 * (0, 0) unless the source specifies a position. Call
 * `controller.applyLayout(...)` (or `layouts.apply(...)`) after conversion.
 */
export interface GraphAdapter<TSource> {
    readonly kind: string;
    toGraphModel(source: TSource): GraphModel;
}
//# sourceMappingURL=types.d.ts.map
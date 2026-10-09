/**
 * A deterministic, dependency-free force layout.
 *
 * Not a general-purpose graph-drawing library — just enough to make
 * requirement 4 true: position emerges from relationships, with a
 * stable, explainable fallback for anything unconnected. No
 * randomness anywhere. Node order never affects the result: every
 * step computes all forces from the current positions into a delta
 * map, then applies every delta at once, so JS object/array iteration
 * order can never change the outcome — only id order (used solely for
 * making iteration explicit) and the physics do.
 */
export interface LayoutEdge {
    readonly a: string;
    readonly b: string;
    readonly weight: number;
}
export interface LayoutOptions {
    readonly iterations?: number;
    readonly repulsion?: number;
    readonly attraction?: number;
    readonly restLength?: number;
    readonly area?: {
        readonly width: number;
        readonly height: number;
    };
}
export declare function relax(ids: readonly string[], edges: readonly LayoutEdge[], options?: LayoutOptions): Map<string, {
    x: number;
    y: number;
}>;
//# sourceMappingURL=layout.d.ts.map
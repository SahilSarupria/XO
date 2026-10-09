import type { InstallState } from './types.js';
/**
 * The source graph contract.
 *
 * This repository does not currently contain a graph-engine, XOIR, or
 * runtime package to project real data from — see README.md for the
 * inspection this package's design is based on. `SourceGraph` is the
 * minimal shape a future one is expected to either produce directly
 * or be adapted into. Everything in projection.ts depends only on
 * this contract, never on any particular producer of it, so wiring a
 * real source later means writing an adapter that returns a
 * `SourceGraph` — not changing this package.
 *
 * The one real precedent that exists today is the hardcoded
 * `experiences` / `lines` arrays inline in app/page.tsx. This shape
 * is a formalized superset of that: every field page.tsx currently
 * has inline (id, name, kind, status, description, capabilities,
 * x/y) maps directly onto `SourceXO`, and `lines` maps onto
 * `SourceRelationship` once its coordinate pairs are resolved back to
 * ids. See fixtures/sample-graph.ts for that exact mapping, used only
 * by this package's tests.
 */
export interface SourceXO {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly status?: string;
    readonly description?: string;
    readonly publisherId?: string;
    readonly capabilityIds: readonly string[];
    readonly workflowIds?: readonly string[];
    readonly communityId?: string;
    readonly installState?: InstallState;
    readonly metadata?: Readonly<Record<string, unknown>>;
    /** An existing manual or legacy position hint (e.g. the hardcoded
     * x/y percentages presently in app/page.tsx). Used only as a last
     * resort by the deterministic fallback layout — see projection.ts. */
    readonly position?: {
        readonly x: number;
        readonly y: number;
    };
}
export interface SourceRelationship {
    readonly fromId: string;
    readonly toId: string;
    readonly kind?: string;
    readonly weight?: number;
}
export interface SourcePublisher {
    readonly id: string;
    readonly name: string;
    readonly verified?: boolean;
}
export interface SourceCapability {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}
export interface SourceWorkflow {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}
export interface SourceCommunity {
    readonly id: string;
    readonly label: string;
    readonly memberIds: readonly string[];
}
export interface SourceGraph {
    readonly xos: readonly SourceXO[];
    readonly relationships?: readonly SourceRelationship[];
    readonly publishers?: readonly SourcePublisher[];
    /** Optional explicit capability/workflow catalogs. If omitted,
     * projection.ts synthesizes minimal entries from the ids referenced
     * on `xos` so a source graph doesn't have to duplicate a label the
     * consumer doesn't have yet — see projection.ts. */
    readonly capabilities?: readonly SourceCapability[];
    readonly workflows?: readonly SourceWorkflow[];
    readonly communities?: readonly SourceCommunity[];
}
//# sourceMappingURL=source-graph.d.ts.map
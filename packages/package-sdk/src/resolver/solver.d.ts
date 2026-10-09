import type { XoManifest } from '@xo/types';
import { type Result } from '@xo/types';
import { DependencyError } from '@xo/errors';
import type { DependencyGraph } from './dependency-graph.js';
export interface ResolvedDependency {
    readonly name: string;
    readonly version: string;
    readonly manifest: XoManifest;
}
/** An optional dependency the solver could not resolve — recorded rather than thrown, since a resolution failure on an optional dependency must never fail the whole resolve. */
export interface SkippedOptionalDependency {
    readonly name: string;
    readonly versionRange: string;
    readonly requestedBy: string;
    readonly reason: string;
}
export interface SolveResult {
    readonly resolved: readonly ResolvedDependency[];
    readonly skippedOptional: readonly SkippedOptionalDependency[];
}
/**
 * Given a fully-walked {@link DependencyGraph}, selects a specific
 * version for every `required` dependency name, resolves `optional`
 * dependencies best-effort (never failing the overall resolve), and
 * checks every `peer` requirement against whatever was resolved through
 * the required/optional paths — never resolving a peer independently,
 * per the brief this module was built against.
 */
export declare function solveDependencyGraph(graph: DependencyGraph): Result<SolveResult, DependencyError>;
//# sourceMappingURL=solver.d.ts.map
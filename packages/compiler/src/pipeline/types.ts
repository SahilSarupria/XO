import type { Logger } from '@xo/logger';
import type { Diagnostic, GraphStats, MergeStrategy, PassRunSummary, ValidationReport, XoirGraph } from '@xo/xoir';
import type { CapabilityGraph } from '../capabilities/types.js';
import type { KnowledgeGraph } from '../knowledge/types.js';
import type { ReasoningGraph } from '../reasoning/types.js';

/**
 * What `compileXoir` (`compile.ts`) accepts. Every variant terminates at
 * XOIR before any pipeline stage runs — see the package README's
 * "XOIR-first pipeline" section. `'xoir'` is the forward-looking escape
 * hatch Stage 6 §14 describes: a future source adapter (image, video,
 * web, ...) that already produces XOIR directly (rather than through a
 * Stage 4/5-shaped domain model) enters the pipeline here, at the exact
 * same boundary Stage 4/5 do, without this module ever needing to know
 * that adapter exists.
 *
 * `reasoning` (Stage 7, optional on every domain-input variant) is
 * composed into the same target graph via `reasoningGraphToXoir`'s
 * `into` mechanism, exactly the way `'combined'` already composes
 * Knowledge and Capability — see `compile.ts#convertToXoir`'s doc
 * comment for the exact ordering. It is optional because Stage 7
 * enrichment is additive, never required: a caller with no reasoning
 * extraction to contribute still gets a fully valid pipeline run.
 */
export type PipelineInput =
  | { readonly kind: 'knowledge'; readonly graph: KnowledgeGraph; readonly reasoning?: ReasoningGraph }
  | { readonly kind: 'capability'; readonly graph: CapabilityGraph; readonly reasoning?: ReasoningGraph }
  | { readonly kind: 'combined'; readonly knowledge: KnowledgeGraph; readonly capability: CapabilityGraph; readonly reasoning?: ReasoningGraph }
  | { readonly kind: 'xoir'; readonly graph: XoirGraph };

export interface CompileXoirOptions {
  /** Only used for the `'knowledge'`/`'capability'`/`'combined'` input kinds, where a fresh `XoirGraph` is constructed — see `knowledgeGraphToXoir`/`capabilityGraphToXoir` in `../xoir/`. Ignored for `'xoir'` input, which already has a graph id. */
  readonly graphId?: string;
  readonly now?: () => string;
  readonly logger?: Logger;
  /** Reserved for a future caller that needs to combine more than one independently-produced `XoirGraph` (via `@xo/xoir#mergeGraphsPreservingProvenance`) ahead of this pipeline — not used by the `'combined'` input kind itself, which uses the simpler, conflict-free `into` mechanism (see the package README). */
  readonly mergeStrategy?: MergeStrategy;
}

/**
 * The Stage 6 pipeline's output — the "compiled artifact" the task
 * description's diagram refers to, at the level of maturity Stage 6 is
 * responsible for: a validated, normalized, canonical `XoirGraph`.
 * Optimization, linking, and benchmark synthesis (real "compilation" in
 * the fuller sense `EXPERIENCE_COMPILER.md` describes) are explicitly out
 * of scope for this stage — see the package README.
 */
export interface CompiledXoirResult {
  readonly graph: XoirGraph;
  readonly valid: boolean;
  readonly validation: ValidationReport;
  readonly diagnostics: readonly Diagnostic[];
  readonly passRuns: readonly PassRunSummary[];
  readonly stats: GraphStats;
}

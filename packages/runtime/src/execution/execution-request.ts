import type { HostProfile } from '@xo/package-sdk';
import type { EnvironmentId, RequestId } from '../ids.js';
import type { WorkflowGraph } from '../workflow/workflow-graph.js';

/**
 * The target environment an execution plan is being prepared for — the
 * runtime's equivalent of a process's environment variables. Carries
 * everything the negotiator needs to resolve compatibility and everything
 * `ExecutionSession`/`ExecutionReceipt` need to track, but nothing about
 * *how* to actually call a provider (no API keys, no endpoints — Stage 1
 * never makes an AI provider call, so there's nothing here for one to
 * use).
 */
export interface ExecutionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly hostProfile: HostProfile;
  readonly provider?: string;
  readonly tokenBudget?: number;
  readonly createdAt: string;
}

/**
 * A request for a capability, to be turned into an {@link ExecutionPlan}
 * by `CapabilityNegotiator`. At least one of `capabilityId` (exact match)
 * or `query` (deterministic substring match, see
 * `CapabilityRegistry.search`) must be set — enforced by the negotiator,
 * not by this type, since "at least one of two optional fields" isn't
 * expressible as a plain TypeScript interface without a discriminated
 * union that would complicate every call site for no real benefit at
 * this stage.
 */
export interface ExecutionRequest {
  readonly requestId: RequestId;
  readonly capabilityId?: string;
  readonly query?: string;
  readonly environment: ExecutionEnvironment;
  readonly requestedAt: string;
/**
   * Stage 2. The actual task/query text to send to the AI Capability
   * Layer once a capability has been planned — absent for a Stage
   * 1-only planning request (`Runtime.plan`), required by
   * `ExecutionEngine.execute`, which rejects a request missing it before
   * doing any work.
   */
  readonly input?: string;
  /**
   * R1/R2 closure. Structured arguments for a `deterministic_rule`
   * capability (`CapabilityDeclaration.execution.mode`) — validated
   * against that declaration's `execution.inputSchema` (when present)
   * before the resolved binding ever runs, per R2. Distinct from `input`
   * (a free-text task/query string meant for the AI Capability Layer):
   * a deterministic-rule capability's arguments are a flat property bag
   * a `StructuredComparisonBindingResolver`-produced evaluator reads by
   * key, never a prompt. Ignored entirely for a `'model'`-mode (or
   * mode-absent) capability, exactly as `workflowGraph` is ignored
   * outside its own branch — see `ExecutionPipeline`'s doc comment for
   * the dispatch point.
   */
  readonly structuredInput?: Readonly<Record<string, unknown>>;
  /**
   * Stage 2. Extra capability ids (beyond whichever one planning
   * selects) whose packages' knowledge components should be retrieved
   * and merged into context alongside the selected capability's own —
   * see `KnowledgeRetriever`'s knowledge-graph merging.
   */
  readonly auxiliaryCapabilityIds?: readonly string[];
  /** Stage 2. Caps the AI provider's response length; independent of `environment.tokenBudget`, which is the whole request's retrieval+prompt+response budget. */
  readonly maxTokens?: number;
  /**
   * Stage 3. When set, `ExecutionPipeline.run` delegates the entire
   * request to `WorkflowExecutor` instead of the single-capability Stage
   * 2 flow — every field above this one is ignored in that case except
   * `environment` (still used for every `capability` node's synthetic
   * per-node request). Absent (the Stage 1/2 default) means execution
   * continues exactly as it always has; see `ExecutionPipeline`'s doc
   * comment for the exact branch point.
   */
  readonly workflowGraph?: WorkflowGraph;
  /**
   * R6. When `true`, requests simulation semantics for this execution —
   * see `execution/simulation-gate.ts`'s top doc comment for the exact
   * contract per strategy. Absent/`false` (the default) means every
   * pre-R6 caller's behavior is unchanged: a real provider call for
   * `'model'`, a real handler invocation for `'deterministic_rule'`.
   */
  readonly simulate?: boolean;
}


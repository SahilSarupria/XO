import { brand, type Brand } from '@xo/types';

/**
 * The contract Stage 3 consumes, not produces. Nothing in this repo's
 * compiler emits a `WorkflowGraph` yet (`compiler-core` is still
 * interfaces-only, per this repo's own `MODULE_1_REPORT.md`) — this type
 * is `@xo/runtime`'s side of that future integration, written the same
 * way `packages/ai-core`'s provisional stand-in was for Stage 2's first
 * pass: a reasonable, documented, best-effort shape the executor can be
 * built and tested against now, expected to be reconciled against
 * whatever the compiler's own `WorkflowGraph` output type turns out to
 * be once that stage exists. `WorkflowExecutor` never asks *how* a graph
 * was produced — it only consumes this shape, per the brief's explicit
 * "should NOT know how the WorkflowGraph is produced."
 *
 * A `WorkflowGraph` is plain, JSON-serializable data (no closures/functions
 * anywhere in it) so it really could be compiler output, not just
 * runtime-constructed test fixtures — see `WorkflowCondition`'s
 * `'expression'` variant for how conditional branching stays
 * serializable.
 */
export type NodeId = Brand<string, 'NodeId'>;
export const NodeId = (value: string): NodeId => brand(value);

/**
 * `'custom:<name>'` is intentionally a template-literal type, not a
 * fixed enum member — "the runtime should treat node types generically"
 * means `WorkflowExecutor` dispatches every node type (including the
 * nine fixed ones) through the same `NodeHandler` registry; `custom:*`
 * simply has no built-in handler; a caller supplies one via
 * `WorkflowExecutorOptions.customNodeHandlers`.
 */
export type WorkflowNodeType = 'start' | 'end' | 'capability' | 'decision' | 'parallel' | 'sequence' | 'merge' | 'loop' | 'delay' | 'subworkflow' | `custom:${string}`;

export type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'truthy' | 'falsy';

/**
 * A deterministic, no-AI-reasoning condition for `decision`/`loop` edges.
 * `'expression'` is the serializable, compiler-producible form (a
 * dot-path into `WorkflowState.outputs`, compared with `operator`
 * against `value`); `'predicate'` is a programmatic escape hatch for
 * runtime-constructed graphs (tests, hand-authored workflows) that isn't
 * JSON-serializable and therefore isn't something a compiler could ever
 * emit — a real compiled `WorkflowGraph` should only ever use
 * `'expression'`.
 */
export type WorkflowCondition =
  | { readonly kind: 'expression'; readonly field: string; readonly operator: ConditionOperator; readonly value?: unknown }
  | { readonly kind: 'predicate'; readonly evaluate: (outputs: Readonly<Record<string, unknown>>) => boolean };

export interface WorkflowEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  /** Absent means "always taken" (an ordinary sequence edge, or a decision/loop node's default/fallback branch). Evaluated in `graph.edges`' declared order at each decision/loop node — see `WorkflowScheduler`. */
  readonly condition?: WorkflowCondition;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Base backoff before the first retry, milliseconds. */
  readonly backoffMs: number;
  /** Deterministic multiplier applied per additional attempt (1 = fixed backoff). No jitter — "no randomness" is a hard constraint for this whole subsystem. */
  readonly backoffMultiplier?: number;
}

/**
 * Node-type-specific configuration, carried generically as a plain
 * record rather than a per-type field on `WorkflowNode` — the same
 * "treat node types generically" principle applied to config, not just
 * dispatch. Each built-in handler documents which keys it reads:
 * `capability`: `capabilityId`, `input`, `auxiliaryCapabilityIds?`, `maxTokens?`;
 * `delay`: `durationMs`;
 * `loop`: `maxIterations?` (default 1000 — a hard termination guard, not a suggestion);
 * `subworkflow`: `graph` (a nested `WorkflowGraph`);
 * anything else: unused by built-in handlers, free for `custom:*` handlers to read.
 */
export type WorkflowNodeConfig = Readonly<Record<string, unknown>>;

export interface WorkflowNode {
  readonly id: NodeId;
  readonly type: WorkflowNodeType;
  readonly name?: string;
  readonly config?: WorkflowNodeConfig;
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs?: number;
}

export interface WorkflowGraph {
  readonly graphId: string;
  readonly version: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly startNodeId: NodeId;
}

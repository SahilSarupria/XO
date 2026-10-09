import type { Brand } from '@xo/types';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import type { StructuredAction, StructuredCondition, StructuredExceptionCondition } from '@xo/capability-contract';

export type ReasoningNodeId = Brand<string, 'ReasoningNodeId'>;

/**
 * Stage 7's own extraction-domain vocabulary — deliberately its own
 * (smaller, source-pattern-shaped) set of names, not a re-declaration of
 * XOIR's canonical kinds, exactly mirroring how `KnowledgeNodeType`
 * (`../knowledge/types.ts`) and `CapabilityCategory`
 * (`../capabilities/types.ts`) are their own vocabularies that a later
 * conversion step (`../xoir/reasoning-to-xoir.ts`) maps onto canonical
 * XOIR kinds. See that file's `REASONING_NODE_TYPE_TO_CANONICAL_KIND` for
 * the mapping and the reasoning behind each choice — in short, every one
 * of these already has a canonical XOIR home (`heuristic`,
 * `decision_node`, or `constraint`); none required a taxonomy extension.
 *
 * - `rule` — a WHEN/IF-condition, THEN-action structure.
 * - `prerequisite` — "before A, B must be done."
 * - `prohibition` — "cannot/must not do X."
 * - `policy` — a broader must/required statement not phrased as a
 *   conditional rule (e.g. "Only managers may approve Y").
 * - `decision` — what was decided, why, under what conditions.
 * - `alternative` — one option in an IF/THEN/ELSE or "preferred when"
 *   structure — its own node so two alternatives can be linked
 *   (`alternative_to`) rather than one swallowing the other.
 * - `justification` — a "because E, therefore D" reasoning step.
 * - `exception` — a standalone "Exception E overrides rule R" statement
 *   (as opposed to an inline `UNLESS` clause, which folds into the rule
 *   it modifies as an `exceptionConditions` entry instead of becoming its
 *   own node — see `rule-pattern-parser.ts`).
 * - `escalation` — a "when X, escalate to Y" structure. Kept distinct
 *   from `rule` (rather than folded into it) because it has an exact,
 *   previously-unused canonical XOIR home with a matching shape —
 *   `escalation_rule` (`triggerCondition`, `escalationTarget`) — that a
 *   generic `heuristic`'s `condition`/`action` would flatten and lose the
 *   "this action is specifically a hand-off" distinction. Currently only
 *   produced by `ai-extractor.ts` (from `@xo/ai-core`'s
 *   `extractDecisionGraph`'s `EscalationPath`s) — no rule-based text
 *   pattern for it yet (documented limitation, not a silent gap).
 * - `risk_threshold` — a "above threshold X on metric M, do A" structure.
 *   Same reasoning as `escalation`: an exact, previously-unused canonical
 *   XOIR home (`risk_policy`: `domain`, `toleranceLevel`,
 *   `overrideConditions`) that fits `@xo/ai-core`'s `RiskThreshold` shape
 *   precisely. Also AI-only for the same reason.
 */
export type KnownReasoningNodeType = 'rule' | 'prerequisite' | 'prohibition' | 'policy' | 'decision' | 'alternative' | 'justification' | 'exception' | 'escalation' | 'risk_threshold';
export type ReasoningNodeType = KnownReasoningNodeType | `custom:${string}`;

/**
 * Stage 7's own edge vocabulary. See `../xoir/reasoning-to-xoir.ts`'s
 * `REASONING_EDGE_TYPE_TO_XOIR` for the mapping onto XOIR edge kinds —
 * every one of these reuses an existing XOIR edge kind (`REQUIRES`,
 * `GOVERNS`, `CONTRADICTS`, `SUPERSEDES`, `TRIGGERED_BY`, `SUPPORTS`,
 * `DEPENDS_ON`) except `alternative_to`, which is the one genuine
 * representational gap — see that file's doc comment for the full
 * before/after analysis of why the other nine candidates in the task's
 * suggested relationship list did NOT need a new XOIR edge kind.
 */
export type KnownReasoningEdgeType = 'condition_of' | 'requires' | 'constrains' | 'excludes' | 'overrides' | 'alternative_to' | 'leads_to' | 'supports' | 'depends_on';
export type ReasoningEdgeType = KnownReasoningEdgeType | `custom:${string}`;

/**
 * A reasoning/decision semantic entity. Every field beyond `condition`
 * lines up 1:1 with a field the eventual canonical XOIR node
 * (`heuristic`/`decision_node`/`constraint`) needs — see
 * `reasoning-to-xoir.ts` — deliberately, so the conversion step is a
 * direct projection, not a re-derivation.
 */
export interface ReasoningNode {
  readonly id: ReasoningNodeId;
  readonly nodeType: ReasoningNodeType;
  /** A deterministic, content-derived summary (e.g. `"<condition> => <action>"` for a rule) — never a caller-supplied label, so node identity (`node-id.ts`) is reproducible from content alone. */
  readonly canonicalLabel: string;
  readonly condition?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly rationale?: string;
  /** UNLESS-clause exceptions folded directly into the rule they modify — see `KnownReasoningNodeType`'s doc comment on the `exception` vs. inline-exception distinction. */
  readonly exceptionConditions: readonly string[];
  readonly confidence: number;
  /**
   * Phase 2, optional and additive — a deterministic structured
   * projection of whichever of `condition`/`action` becomes this node's
   * eventual XOIR "condition" role (see `structured-semantics.ts`'s
   * per-`nodeType` dispatch table for exactly which field that is).
   * Built via `@xo/capability-contract`'s
   * `structured-expression-grammar.ts#parseStructuredCondition` — see
   * that module's doc comment for the "do not guess" discipline this
   * field's absence encodes. Never derived from or competing with
   * `condition`/`action` themselves, which remain the source of truth;
   * this is purely an additional, best-effort structured view.
   */
  readonly structuredCondition?: StructuredCondition;
  /** Same discipline as {@link structuredCondition}, for whichever of `action`/`outcome` becomes this node's eventual XOIR "outcome" role — built via `parseStructuredAction`. */
  readonly structuredAction?: StructuredAction;
  /** One entry per `exceptionConditions` entry, same order, `condition` present only where that exception's own raw text independently parses — see `StructuredExceptionCondition`'s doc comment for why this never affects the existing hard "any exception makes a contract unresolved" gate downstream. */
  readonly structuredExceptions?: readonly StructuredExceptionCondition[];
  /** Reuses Stage 4/5's `KnowledgeProvenance` verbatim — Stage 7 §8's "do not create a second provenance system," honored structurally, not just by convention. */
  readonly provenance: readonly KnowledgeProvenance[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ReasoningEdge {
  readonly id: string;
  readonly type: ReasoningEdgeType;
  readonly fromNodeId: ReasoningNodeId;
  readonly toNodeId: ReasoningNodeId;
  readonly confidence: number;
  readonly provenance: readonly KnowledgeProvenance[];
}

export interface ReasoningGraph {
  readonly nodes: readonly ReasoningNode[];
  readonly edges: readonly ReasoningEdge[];
}

import type { CanonicalXoirNodeKind } from '@xo/xoir';
import type { KnownReasoningNodeType, ReasoningNodeType } from '../reasoning/types.js';

/**
 * Maps every Stage 7 `KnownReasoningNodeType` onto a canonical XOIR
 * `(kind, subtype)` pair — same kind/subtype split Stage 5.5 established
 * for Stage 4/5 (see `node-kind-mapping.ts`'s doc comment for the general
 * pattern): `kind` is the semantic role, `subtype` (always the original
 * Stage 7 type string, set in `reasoning-to-xoir.ts`) is which specific
 * reasoning/decision concept it was.
 *
 * Every one of these already had an exact canonical XOIR home — per
 * Stage 7 §4's explicit instruction, this table adds **zero** new XOIR
 * node kinds:
 *
 * - `rule` -> `heuristic`: `condition`/`action`/`exceptionConditions` is
 *   *exactly* `HeuristicNodeProps`'s shape.
 * - `prerequisite`, `prohibition`, `policy` -> `constraint`: all three
 *   are hard limits (a gating requirement, a forbidden action, a broader
 *   obligation), differing only in `subtype` and in how
 *   `reasoning-to-xoir.ts` fills `ConstraintNodeProps.severity`.
 * - `decision`, `alternative` -> `decision_node`: an "alternative" is
 *   structurally just another decision branch — its own `decision_node`
 *   so two alternatives can be `ALTERNATIVE_TO`-linked (see
 *   `edge-kinds.ts`'s doc comment on that edge kind).
 * - `justification` -> `reasoning_step`: `premise`/`conclusion` is
 *   exactly `rationale`/`outcome`.
 * - `exception` -> `heuristic`: a standalone "X overrides Y" is itself a
 *   rule-shaped entity (its `action` is the overriding behavior); the
 *   `overrides` edge (-> XOIR `SUPERSEDES`) is what actually captures the
 *   "exception" relationship, not the node kind.
 * - `escalation` -> `escalation_rule`: `triggerCondition`/
 *   `escalationTarget` is exactly `EscalationRuleNodeProps`'s shape — a
 *   previously-unused canonical kind Stage 7's AI-assisted path is the
 *   first thing in this repository to actually populate.
 * - `risk_threshold` -> `risk_policy`: `domain`/`toleranceLevel` maps
 *   onto `metric`/`thresholdDescription` — likewise previously unused.
 */
export const REASONING_NODE_TYPE_TO_CANONICAL_KIND: Readonly<Record<KnownReasoningNodeType, CanonicalXoirNodeKind>> = {
  rule: 'heuristic',
  prerequisite: 'constraint',
  prohibition: 'constraint',
  policy: 'constraint',
  decision: 'decision_node',
  alternative: 'decision_node',
  justification: 'reasoning_step',
  exception: 'heuristic',
  escalation: 'escalation_rule',
  risk_threshold: 'risk_policy',
};

function isKnownReasoningNodeType(nodeType: ReasoningNodeType): nodeType is KnownReasoningNodeType {
  return Object.prototype.hasOwnProperty.call(REASONING_NODE_TYPE_TO_CANONICAL_KIND, nodeType);
}

/** Resolves a Stage 7 node's `nodeType` to its canonical XOIR kind. `custom:<name>` types fall back to `heuristic` — the safest default for an unrecognized rule-shaped extension — with the original string always preserved as `subtype` regardless (see `reasoning-to-xoir.ts`). */
export function canonicalKindForReasoningNodeType(nodeType: ReasoningNodeType): CanonicalXoirNodeKind {
  if (isKnownReasoningNodeType(nodeType)) return REASONING_NODE_TYPE_TO_CANONICAL_KIND[nodeType];
  return 'heuristic';
}

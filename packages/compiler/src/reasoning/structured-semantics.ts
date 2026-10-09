/**
 * Phase 2 — Structured Semantic Expressions, compiler-side glue.
 *
 * `@xo/capability-contract`'s `structured-expression-grammar.ts` is the
 * actual grammar (deterministic, closed-vocabulary, "do not guess" — see
 * that module's doc comment). This file's only job is deciding WHICH of
 * a reasoning candidate's `condition`/`action`/`outcome` text fields to
 * feed into that grammar, for a given `nodeType` — and that decision is
 * not a new one Phase 2 invents: it is exactly the same per-canonical-
 * kind field selection `../xoir/reasoning-to-xoir.ts#buildProperties`
 * already makes when it decides what text becomes a `heuristic`'s
 * `condition`/`action`, a `decision_node`'s `question`/`outcome`, or a
 * `constraint`'s `rule`. Reusing `canonicalKindForReasoningNodeType`
 * (rather than re-deriving that mapping here) is what keeps the two
 * files' selection logic provably identical rather than two
 * hand-maintained copies that could silently drift apart — a structured
 * projection of the WRONG text (e.g. structuring `condition` for a node
 * whose XOIR "condition" role is actually filled by `action`) would be
 * worse than no structured projection at all.
 *
 * `reasoning_step`, `escalation_rule`, and `risk_policy` canonical kinds
 * are deliberately out of scope here (see the early return below) — Phase
 * 2's XOIR extension (`@xo/xoir`'s `node-kinds.ts`) only added a
 * `structuredCondition`/`structuredAction` slot to `HeuristicNodeProps`,
 * `DecisionNodeNodeProps`, and `ConstraintNodeProps`, matching exactly
 * the three kinds `@xo/capability-contract`'s `contract-builder.ts`
 * actually consumes into a `SemanticCapabilityRule` — the smallest
 * correct Phase 2 extension the brief asks for, not a speculative
 * structuring of node kinds nothing downstream reads yet.
 */

import { parseStructuredAction, parseStructuredCondition, type StructuredAction, type StructuredCondition, type StructuredExceptionCondition } from '@xo/capability-contract';
import { canonicalKindForReasoningNodeType } from '../xoir/reasoning-node-kind-mapping.js';
import type { ReasoningNodeType } from './types.js';

export interface StructuredSemanticsInput {
  readonly nodeType: ReasoningNodeType;
  readonly condition?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly exceptionConditions: readonly string[];
}

export interface StructuredSemanticsOutput {
  readonly structuredCondition?: StructuredCondition;
  readonly structuredAction?: StructuredAction;
  readonly structuredExceptions?: readonly StructuredExceptionCondition[];
}

const EMPTY_OUTPUT: StructuredSemanticsOutput = {};

/**
 * `condition`/`action` here are candidate-local field names (Stage 7's
 * own vocabulary — see `ReasoningNode`'s doc comment), not yet XOIR
 * property names; this function's whole purpose is bridging that gap the
 * same way `buildProperties` does, one stage later, for the same node.
 */
function resolveSourceTexts(input: StructuredSemanticsInput): { readonly conditionSourceText?: string; readonly actionSourceText?: string } {
  const kind = canonicalKindForReasoningNodeType(input.nodeType);
  switch (kind) {
    case 'heuristic':
      // Matches buildProperties's `{ condition: node.condition ?? fallback, action: node.action ?? fallback }`.
      return { ...(input.condition !== undefined ? { conditionSourceText: input.condition } : {}), ...(input.action !== undefined ? { actionSourceText: input.action } : {}) };
    case 'constraint': {
      // Matches buildProperties's `{ rule: node.action ?? node.condition ?? fallback }` — a constraint node has no separate action/outcome slot.
      const conditionSourceText = input.action ?? input.condition;
      return conditionSourceText !== undefined ? { conditionSourceText } : {};
    }
    case 'decision_node':
      // Matches buildProperties's `{ question: node.condition ?? fallback, outcome: node.outcome ?? fallback }`.
      return { ...(input.condition !== undefined ? { conditionSourceText: input.condition } : {}), ...(input.outcome !== undefined ? { actionSourceText: input.outcome } : {}) };
    default:
      // reasoning_step / escalation_rule / risk_policy — see module doc comment.
      return {};
  }
}

/**
 * Best-effort structured projection of each raw exception string,
 * preserving order. Never affects `exceptionConditions` itself (still the
 * source of truth, and still the field `StructuredComparisonBindingResolver`
 * gates on) — see `StructuredExceptionCondition`'s doc comment.
 */
function buildStructuredExceptions(exceptionConditions: readonly string[]): readonly StructuredExceptionCondition[] | undefined {
  if (exceptionConditions.length === 0) return undefined;
  return exceptionConditions.map((raw) => {
    const condition = parseStructuredCondition(raw);
    return condition !== undefined ? { raw, condition } : { raw };
  });
}

/**
 * Computes the Phase 2 structured fields for one reasoning candidate/node.
 * Pure and deterministic given the same input — same property every other
 * pass in this compiler already requires (see `EXPERIENCE_COMPILER.md`
 * §4.6, "Determinism and idempotence," even though this isn't formally
 * registered as a Pass Manager pass). Returns `{}` (no fields set) rather
 * than `undefined`-valued fields when nothing structures, so callers can
 * always safely spread the result.
 */
export function buildStructuredSemantics(input: StructuredSemanticsInput): StructuredSemanticsOutput {
  const { conditionSourceText, actionSourceText } = resolveSourceTexts(input);
  if (conditionSourceText === undefined && actionSourceText === undefined) return EMPTY_OUTPUT;

  const structuredCondition = conditionSourceText !== undefined ? parseStructuredCondition(conditionSourceText) : undefined;
  const structuredAction = actionSourceText !== undefined ? parseStructuredAction(actionSourceText) : undefined;
  const structuredExceptions = buildStructuredExceptions(input.exceptionConditions);

  return {
    ...(structuredCondition !== undefined ? { structuredCondition } : {}),
    ...(structuredAction !== undefined ? { structuredAction } : {}),
    ...(structuredExceptions !== undefined ? { structuredExceptions } : {}),
  };
}

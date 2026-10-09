import type { XoirEdgeKind } from '@xo/xoir';
import type { KnownReasoningEdgeType, ReasoningEdgeType } from '../reasoning/types.js';

/**
 * Maps every Stage 7 `KnownReasoningEdgeType` onto a XOIR edge kind.
 * Nine of the ten reasoning relationships the task's own suggested list
 * named (`CONDITION_OF`, `REQUIRES`, `CONSTRAINS`, `EXCLUDES`,
 * `OVERRIDES`, `LEADS_TO`/`RESULTS_IN`, `SUPPORTS`/`JUSTIFIES`,
 * `DEPENDS_ON`) reuse an *existing* XOIR edge kind — only
 * `ALTERNATIVE_TO` was a genuine gap (see `edge-kinds.ts`'s doc comment
 * on it). Documented per mapping, since several are not simple
 * same-name reuse:
 *
 * - `condition_of` -> `REQUIRES`: "X is a condition of Y" means Y
 *   requires X to hold.
 * - `requires` -> `REQUIRES`: direct reuse.
 * - `constrains` -> `GOVERNS`: `GOVERNS` already exists (from Stage 4's
 *   `governs` edge type) with exactly this "a rule applies to/governs a
 *   target" meaning.
 * - `excludes` -> `CONTRADICTS`: two mutually-incompatible options are,
 *   at the semantic level `CONTRADICTS` was built for, exactly two
 *   claims that can't both hold — a documented semantic stretch, not a
 *   perfect fit, but closer than any other existing kind and not worth a
 *   third near-duplicate of `CONTRADICTS`/`CONFLICTS_WITH`.
 * - `overrides` -> `SUPERSEDES`: "the exception overrides the general
 *   rule" is precisely what `SUPERSEDES` already means.
 * - `alternative_to` -> `ALTERNATIVE_TO`: the one genuine addition.
 * - `leads_to` -> `TRIGGERED_BY`, **reversed**: XOIR's existing
 *   `TRIGGERED_BY` reads "fromId is triggered by toId." "A leads to B" is
 *   the same fact stated the other way around ("B is triggered by A"),
 *   so `reasoning-to-xoir.ts` swaps `fromId`/`toId` when emitting this
 *   one rather than adding a redundant forward-direction edge kind.
 * - `supports` -> `SUPPORTS`: direct reuse ("evidence supports
 *   decision" is exactly `SUPPORTS`'s existing meaning); `justifies` is
 *   folded into the same `supports` Stage 7 type (see `types.ts`) since
 *   there is no meaningful distinction XOIR draws between the two.
 * - `depends_on` -> `DEPENDS_ON`: direct reuse, generic fallback.
 */
export const REASONING_EDGE_TYPE_TO_XOIR: Readonly<Record<KnownReasoningEdgeType, XoirEdgeKind>> = {
  condition_of: 'REQUIRES',
  requires: 'REQUIRES',
  constrains: 'GOVERNS',
  excludes: 'CONTRADICTS',
  overrides: 'SUPERSEDES',
  alternative_to: 'ALTERNATIVE_TO',
  leads_to: 'TRIGGERED_BY',
  supports: 'SUPPORTS',
  depends_on: 'DEPENDS_ON',
};

function isKnownReasoningEdgeType(type: ReasoningEdgeType): type is KnownReasoningEdgeType {
  return Object.prototype.hasOwnProperty.call(REASONING_EDGE_TYPE_TO_XOIR, type);
}

export function xoirEdgeKindForReasoningEdgeType(type: ReasoningEdgeType): XoirEdgeKind {
  if (isKnownReasoningEdgeType(type)) return REASONING_EDGE_TYPE_TO_XOIR[type];
  return type;
}

/** `leads_to` is the one reasoning edge type whose XOIR direction is reversed relative to its own `fromId`/`toId` — see the doc comment on `REASONING_EDGE_TYPE_TO_XOIR.leads_to` above. */
export function isReversedReasoningEdgeType(type: ReasoningEdgeType): boolean {
  return type === 'leads_to';
}

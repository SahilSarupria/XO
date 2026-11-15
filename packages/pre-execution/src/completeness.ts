/**
 * PX-3 (gaps PX-G12, PX-G13; ADR 0029 decision 7): validity is not completeness, and open work is closed only by a
 * recorded human ruling.
 *
 * VALIDITY is structural: the graph's own validation passed. COMPLETENESS asks whether everything the sources say was
 * accounted for: every page read (or waived), no sentence the compiler judged meaningful left unparsed, no conflict left
 * unresolved, no review item that blocks trust left open. A valid graph can be incomplete, and the assessment says so.
 *
 * A HUMAN RULING closes one review item. It is structured (what was decided, not just "OK"), attributed to the person who
 * made it, time-stamped, linked to the evidence (the item's own text), and bound to the source set it was made on: the
 * same sentence in a different set of sources needs a new ruling, and a ruling whose item no longer exists (the sentence
 * changed) is reported as stale, never silently applied. A `confirm-rule` ruling also becomes a confirmed rule for the
 * next compilation (`CompileConfiguration.confirmedRules`), so the decision is reproduced, not just remembered.
 */
import type { ConfirmedRule } from '@xo/compiler';
import { digestOf, type Digest } from './canonical.js';
import type { CompilationArtifact } from './compilation-artifact.js';
import { assessSourceQuality, type SourceWaiver } from './source-quality.js';

export const HUMAN_RULING_SCHEMA = 'xo.human-ruling.v1';

export type RulingDecision =
  /** The text carries no rule or action (a heading, an example, background). */
  | { readonly kind: 'not-operational'; readonly note?: string }
  /** The text states this rule; the next compilation takes it as a confirmed rule. */
  | { readonly kind: 'confirm-rule'; readonly condition: string; readonly outcome: string }
  /** A conflict: which side prevails, and why. */
  | { readonly kind: 'resolve-conflict'; readonly prevails: 'a' | 'b'; readonly rationale: string }
  /** The item was read and accepted as stated (an informational or human-required item). */
  | { readonly kind: 'acknowledge'; readonly note: string };

export interface HumanRuling {
  readonly schema: typeof HUMAN_RULING_SCHEMA;
  readonly rulingId: string;
  /** The review item ruled on (`ReviewQueueItem.id`, a digest of its kind and text). */
  readonly reviewItemId: string;
  readonly reviewItemKind: string;
  /** The item's text as the person saw it — the evidence the ruling rests on. */
  readonly evidence: string;
  /** The source set the ruling was made on; it does not apply to another set. */
  readonly sourceSetId: string;
  readonly decision: RulingDecision;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly createdAt: string;
  readonly digest: Digest;
}

interface ReviewItemView {
  readonly id: string;
  readonly kind: string;
  readonly priority: 1 | 2 | 3;
  readonly summary: string;
  readonly detail: string;
}

function reviewItemsOf(artifact: CompilationArtifact): readonly ReviewItemView[] {
  return ((artifact.reviewQueue as { items?: readonly ReviewItemView[] } | undefined)?.items ?? []) as readonly ReviewItemView[];
}

export interface RulingInput {
  readonly artifact: CompilationArtifact;
  readonly reviewItemId: string;
  readonly decision: RulingDecision;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly createdAt: string;
}

/** Creates a ruling on a review item of `artifact`. Throws for an unknown item, a decision that does not fit it, or empty text. */
export function createHumanRuling(input: RulingInput): HumanRuling {
  const item = reviewItemsOf(input.artifact).find((i) => i.id === input.reviewItemId);
  if (item === undefined) throw new Error(`"${input.reviewItemId}" is not a review item of this compilation`);
  const d = input.decision;
  if (d.kind === 'resolve-conflict' && item.kind !== 'conflict') throw new Error('only a conflict can be resolved with resolve-conflict');
  if (d.kind !== 'resolve-conflict' && item.kind === 'conflict')
    throw new Error('a conflict needs a resolve-conflict ruling (which side prevails, and why)');
  if (d.kind === 'confirm-rule' && (d.condition.trim().length === 0 || d.outcome.trim().length === 0))
    throw new Error('a confirmed rule needs a condition and an outcome');
  if (d.kind === 'resolve-conflict' && d.rationale.trim().length < 10)
    throw new Error('a conflict ruling needs a rationale (10 characters or more)');
  if (d.kind === 'acknowledge' && d.note.trim().length === 0) throw new Error('an acknowledgement needs a note');
  const body = {
    schema: HUMAN_RULING_SCHEMA,
    reviewItemId: item.id,
    reviewItemKind: item.kind,
    evidence: item.summary,
    sourceSetId: input.artifact.sourceSet.sourceSetId,
    decision: d,
    actor: input.actor,
    createdAt: input.createdAt,
  } as const;
  const digest = digestOf(body);
  return { ...body, rulingId: `rul_${digest.slice(7, 31)}`, digest };
}

export function verifyHumanRuling(ruling: HumanRuling): boolean {
  if (ruling.schema !== HUMAN_RULING_SCHEMA) return false;
  const { digest, rulingId, ...body } = ruling;
  return digestOf(body) === digest && rulingId === `rul_${digest.slice(7, 31)}`;
}

/** The `confirm-rule` rulings for a source set, as the compiler's confirmed rules (for the next compilation). */
export function confirmedRulesFrom(rulings: readonly HumanRuling[], sourceSetId: string): readonly ConfirmedRule[] {
  return rulings
    .filter((r) => r.sourceSetId === sourceSetId && r.decision.kind === 'confirm-rule' && verifyHumanRuling(r))
    .map((r) => {
      const d = r.decision as Extract<RulingDecision, { kind: 'confirm-rule' }>;
      return { sourceText: r.evidence, condition: d.condition, outcome: d.outcome, confirmedBy: r.actor.id, confirmedAt: r.createdAt };
    });
}

// ── completeness ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type CompletenessDimensionId = 'structure' | 'source-coverage' | 'review-items' | 'conflicts' | 'unparsed-sentences';

export interface CompletenessDimension {
  readonly id: CompletenessDimensionId;
  readonly status: 'complete' | 'incomplete';
  /** Open items, with enough to act on each. */
  readonly open: readonly { readonly ref: string; readonly detail: string }[];
  /** Items closed by a ruling or a waiver. */
  readonly closed: number;
}

export interface CompletenessAssessment {
  /** Structural validity of the graph (decision 7: reported separately from completeness). */
  readonly valid: boolean;
  readonly complete: boolean;
  readonly dimensions: readonly CompletenessDimension[];
  readonly appliedRulings: readonly string[];
  /** Rulings that name an item this compilation no longer has, or another source set, or whose digest fails. */
  readonly staleRulings: readonly { readonly rulingId: string; readonly reason: string }[];
}

/**
 * Assesses `artifact` for completeness. Priority-1 and -2 review items (they block trust or need a decision) are open until
 * ruled on; priority-3 items are informational and never block. Unread pages count as open unless a readiness waiver
 * covers them. The structural dimension is open when the graph is invalid.
 */
export function assessCompleteness(
  artifact: CompilationArtifact,
  rulings: readonly HumanRuling[] = [],
  waivers: readonly SourceWaiver[] = [],
): CompletenessAssessment {
  const items = reviewItemsOf(artifact);
  const itemIds = new Set(items.map((i) => i.id));
  const stale: { rulingId: string; reason: string }[] = [];
  const usable = new Map<string, HumanRuling>();
  for (const r of rulings) {
    if (!verifyHumanRuling(r)) stale.push({ rulingId: r.rulingId, reason: 'its digest does not match its content' });
    else if (r.sourceSetId !== artifact.sourceSet.sourceSetId)
      continue; // another set's ruling: not this compilation's business
    else if (!itemIds.has(r.reviewItemId))
      stale.push({ rulingId: r.rulingId, reason: 'the item it ruled on is no longer in this compilation (its text changed)' });
    else usable.set(r.reviewItemId, r);
  }

  const structureOpen = artifact.valid ? [] : [{ ref: 'graph', detail: 'the compiled graph failed structural validation' }];

  const quality = assessSourceQuality(artifact, waivers, 'readiness');
  const coverageOpen = quality.sources.flatMap((s) => s.unwaived.map((f) => ({ ref: `${s.name}#${f.key}`, detail: f.detail })));
  const coverageClosed = quality.sources.reduce((n, s) => n + (s.findings.length - s.unwaived.length), 0);

  const blocking = items.filter((i) => i.priority !== 3);
  const conflicts = blocking.filter((i) => i.kind === 'conflict');
  const unparsed = blocking.filter((i) => i.kind === 'uncovered-sentence' || i.kind === 'unresolved-condition');
  const other = blocking.filter((i) => !conflicts.includes(i) && !unparsed.includes(i) && i.kind !== 'ocr-required');
  const dim = (id: CompletenessDimensionId, list: readonly ReviewItemView[]): CompletenessDimension => {
    const open = list.filter((i) => !usable.has(i.id)).map((i) => ({ ref: i.id, detail: `${i.kind}: ${i.summary}` }));
    return { id, status: open.length === 0 ? 'complete' : 'incomplete', open, closed: list.length - open.length };
  };
  const dimensions: CompletenessDimension[] = [
    { id: 'structure', status: structureOpen.length === 0 ? 'complete' : 'incomplete', open: structureOpen, closed: 0 },
    { id: 'source-coverage', status: coverageOpen.length === 0 ? 'complete' : 'incomplete', open: coverageOpen, closed: coverageClosed },
    dim('unparsed-sentences', unparsed),
    dim('conflicts', conflicts),
    dim('review-items', other),
  ];
  return {
    valid: artifact.valid,
    complete: dimensions.every((d) => d.status === 'complete'),
    dimensions,
    appliedRulings: [...usable.values()].map((r) => r.rulingId),
    staleRulings: stale,
  };
}

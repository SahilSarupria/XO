/**
 * M1.1 — Rule-level capability minting.
 *
 * Root cause (recorded during M1.1 diagnosis): capability extraction
 * (`rule-based-extractor.ts`) only ever produces coarse, section/verb-
 * scoped capabilities (e.g. one generic "Review Action" capability per
 * `ExperienceUnit`). Reasoning extraction, running independently,
 * produces one `heuristic`/`decision_node` per individual decision rule.
 * Same-unit evidence-based linking (`../xoir/rule-capability-linking.ts`)
 * then correctly (per its own design) attaches every rule in a unit to
 * whatever generic capability that unit produced — so a document
 * section with 8 semantically distinct decision rules (e.g. a real
 * policy's "7. Decision Rules") ends up as one 8-rule capability
 * contract, and `StructuredComparisonBindingResolver`'s deliberate
 * all-or-nothing policy means a single unsupported rule (an exception,
 * a temporal condition, a prerequisite) blocks every other rule in that
 * bundle from ever becoming executable — even rules that are, on their
 * own, already fully and cleanly structured.
 *
 * This module is the smallest additive fix for that: for every
 * `ReasoningNode` whose condition ALREADY compiles cleanly under the
 * existing structured-expression grammar (no exception clause, no
 * temporal leaf anywhere in its condition tree, a real outcome — i.e. it
 * would resolve today if it were the only rule in its capability), mint
 * a dedicated `Capability` representing just that one rule. Existing
 * verb-/title-based capability extraction (`rule-based-extractor.ts`) is
 * completely untouched — its output (e.g. "Review Action") is preserved
 * unchanged for provenance/audit visibility of the full rule set,
 * including the still-unsupported rules.
 *
 * Explicitly NOT minted (fail-closed, matches M1's "false negative over
 * false positive" principle):
 * - bare constraints (no outcome — not a decision-table branch)
 * - rules with any exception clause
 * - rules whose structured condition contains a `'temporal'` leaf
 *   anywhere in its and/or tree
 * - rules with no `structuredCondition` at all (never guessed at)
 *
 * This module never invents new grammar, never changes the resolver's
 * all-or-nothing semantics, and never touches the existing linker's
 * general same-unit-term-overlap scoring — see
 * `../xoir/rule-capability-linking.ts`'s `linkMintedRuleCapabilities`
 * for how a minted capability's binding to its own originating rule is
 * made reliable without contaminating (or being contaminated by) other
 * same-unit rules.
 */

import type { StructuredCondition } from '@xo/capability-contract';
import { brand } from '@xo/types';
import { Sha256Hasher } from '@xo/crypto';
import { UNKNOWN_SIGNATURE, type Capability, type CapabilityId } from './types.js';
import { canonicalKindForReasoningNodeType } from '../xoir/reasoning-node-kind-mapping.js';
import { RULE_DERIVED_METADATA_KEY, RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY } from '../xoir/rule-capability-linking.js';
import type { ReasoningGraph, ReasoningNode } from '../reasoning/types.js';

export { RULE_DERIVED_METADATA_KEY, RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY };

/** Metadata key marking a `Capability` (and, once converted, its XOIR node) as minted by this module, rather than by `rule-based-extractor.ts`. Read by `rule-capability-linking.ts` to (a) exclude these capabilities from the generic same-unit-term-overlap candidate pool and (b) create each one's single deterministic edge back to its originating rule. Re-exported from `../xoir/rule-capability-linking.ts`, which is this constant's source of truth (see that module's doc comment for why). */


/**
 * The XOIR-facing "outcome text" for a rule, matching
 * `../xoir/reasoning-to-xoir.ts#buildProperties`'s exact per-kind field
 * selection (`heuristic` -> `node.action`, `decision_node` ->
 * `node.outcome`) rather than assuming one field name universally —
 * `ReasoningNode.outcome` is only ever populated for `nodeType: 'decision'
 * | 'alternative'` (canonical kind `decision_node`); every other rule
 * shape that reaches `'heuristic'` (`nodeType: 'rule' | 'exception'`)
 * carries its result text in `node.action` instead. Returns `undefined`
 * for anything that isn't `'heuristic'`/`'decision_node'` — matching
 * {@link isCleanlyExecutableRule}'s own kind gate below, since
 * `'constraint'` has no outcome slot at all (see `buildProperties`'s
 * `'constraint'` case, which never reads `node.outcome`/`node.action` as
 * a decision-table outcome, only as its `rule` summary text).
 */
function outcomeTextFor(kind: ReturnType<typeof canonicalKindForReasoningNodeType>, node: ReasoningNode): string | undefined {
  if (kind === 'heuristic') return node.action;
  if (kind === 'decision_node') return node.outcome;
  return undefined;
}

/**
 * True when `condition` (and, recursively, every operand of an
 * `and`/`or`) is a shape `StructuredComparisonBindingResolver`'s
 * `compileStructuredCondition` would actually compile, rather than
 * refuse. Deliberately mirrors that function's exact acceptance rule —
 * not a separately-maintained notion of "clean" — so this module and the
 * resolver can never silently drift apart on what counts as executable.
 * `comparison`/`categorical`/`range` leaves are always compilable.
 * `temporal` leaves are compilable only for the M1.3 duration-with-field
 * shape (`amount`+`unit`+`field` all present, `relation` `'within'` or
 * `'after'`) — see `structured-comparison-resolver.ts`'s own doc comment
 * on that condition for the full rationale (a plain numeric comparison
 * against a runtime-supplied day-count, never a date/time engine). Every
 * other temporal shape (anchor-only, or a duration with no capturable
 * `field`) remains excluded exactly as it always has. Field-key
 * resolution itself is not re-checked here because this pipeline never
 * declares `SemanticCapabilityContract.inputs` (`resolveFieldKey`
 * always takes its always-succeeding empty-declared-inputs fallback
 * path today), so structural (type) shape is the only thing that can
 * actually fail compilation.
 */
function isResolverCompilable(condition: StructuredCondition): boolean {
  if (condition.type === 'and' || condition.type === 'or') {
    return condition.operands.every(isResolverCompilable);
  }
  if (condition.type === 'temporal') {
    return condition.amount !== undefined && condition.unit !== undefined && condition.field !== undefined && (condition.relation === 'within' || condition.relation === 'after');
  }
  return true;
}

/** True when `node` is, on its own, already a fully executable decision-table branch — the exact gate this module mints a dedicated capability for. */
function isCleanlyExecutableRule(node: ReasoningNode): boolean {
  const kind = canonicalKindForReasoningNodeType(node.nodeType);
  if (kind !== 'heuristic' && kind !== 'decision_node') return false; // bare constraints and anything else are never decision-table branches
  const outcome = outcomeTextFor(kind, node);
  if (outcome === undefined || outcome.trim().length === 0) return false;
  if (node.exceptionConditions.length > 0) return false;
  if (node.structuredCondition === undefined) return false;
  return isResolverCompilable(node.structuredCondition);
}

const MAX_NAME_LENGTH = 80;

const hasher = new Sha256Hasher();

/**
 * A minted capability's id is derived directly from its unique
 * originating `ReasoningNode.id` (a content hash already — see
 * `reasoning-extractor.ts`), never from `computeCapabilityId(category,
 * name)` (`capability-id.ts`) — that function deliberately *unifies*
 * capabilities with a matching normalized name (its entire purpose for
 * verb-/title-derived capabilities), which is exactly wrong here: two
 * different rules that happen to share outcome wording (e.g. two
 * different "manager approval is required" branches with different
 * conditions) must never collapse into one minted capability and
 * silently lose one rule's binding. This keeps minting a strict 1:1,
 * collision-free map from rule to capability, independent of name text.
 */
function mintedCapabilityId(sourceReasoningNodeId: string): CapabilityId {
  return brand(`cap_rule_${hasher.hash(sourceReasoningNodeId).replace('sha256:', '').slice(0, 32)}`);
}


/** A short, deterministic, human-readable capability name derived from the rule's own outcome text — e.g. `"manager approval is required"` -> `"Manager Approval Is Required"`. Never guesses beyond simple title-casing; truncates (never mid-word) rather than fabricating a summary. */
function nameFromOutcome(outcome: string): string {
  const trimmed = outcome.trim().replace(/[.;]+$/, '');
  const titleCased = trimmed
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
  if (titleCased.length <= MAX_NAME_LENGTH) return titleCased;
  const truncated = titleCased.slice(0, MAX_NAME_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

/**
 * Mints one dedicated `Capability` per cleanly-executable `ReasoningNode`
 * in `reasoning`. Deterministic and idempotent: re-running against
 * identical `reasoning` input yields byte-identical `Capability` ids
 * (via `computeCapabilityId`, content-hashed from category + name,
 * same convention every other capability in this compiler already
 * uses) and content.
 */
export function mintRuleLevelCapabilities(reasoning: ReasoningGraph): readonly Capability[] {
  const minted: Capability[] = [];
  for (const node of reasoning.nodes) {
    if (!isCleanlyExecutableRule(node)) continue;
    const kind = canonicalKindForReasoningNodeType(node.nodeType);

    const outcome = outcomeTextFor(kind, node)!.trim();
    const condition = node.condition?.trim();
    const name = nameFromOutcome(outcome);
    const description = condition !== undefined && condition.length > 0 ? `If ${condition}, then ${outcome}.` : outcome;

    const id: CapabilityId = mintedCapabilityId(node.id);
    minted.push({
      id,
      canonicalName: name,
      aliases: [],
      description,
      category: 'action',
      confidence: node.confidence,
      provenance: node.provenance,
      inputs: [],
      outputs: [],
      dependencies: [],
      requiredKnowledgeNodeIds: [],
      relatedConcepts: [],
      requiredPermissions: [],
      invocationHints: [],
      examples: [],
      signature: UNKNOWN_SIGNATURE,
      metadata: {
        [RULE_DERIVED_METADATA_KEY]: 'true',
        [RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY]: node.id,
      },
    });
  }
  return minted;
}

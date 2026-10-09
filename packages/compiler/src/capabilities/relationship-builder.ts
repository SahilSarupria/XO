import type { KnowledgeProvenance } from '../knowledge/types.js';
import type { PerUnitCapabilityExtraction, CapabilityMergeResult } from './merge.js';
import { computeCapabilityRelationshipId } from './capability-id.js';
import type { Capability, CapabilityId, CapabilityRelationship, CapabilityRelationType } from './types.js';

const EXTENDS_CONFIDENCE = 0.6;
const COMPLEMENTS_CONFIDENCE = 0.5;
const DEPENDS_ON_CONFIDENCE = 0.55;
const MIN_MENTION_LABEL_LENGTH = 4;

/**
 * Sequence Evidence for Workflow Composition (see this package's README,
 * Stage 5, "Sequence evidence" section).
 *
 * A deliberately weaker relation than any of `extends`/`complements`/
 * `depends_on`, expressed via `CapabilityRelationType`'s existing
 * `custom:${string}` escape hatch rather than as a new taxonomy member —
 * see the Sequence Evidence design note in this file's top-level doc
 * comment for why no existing named relation (nor a new core type) is
 * used instead. `fromCapabilityId` is the earlier step, `toCapabilityId`
 * the later one — "fromId precedes toId in the source's procedural
 * order," never "fromId is required by toId." Two independent evidence
 * sources populate it, each with its own confidence tier reflecting how
 * directly the adjacency was observed:
 *
 * - **Within-unit** (`SEQUENCE_WITHIN_UNIT_CONFIDENCE`): consecutive
 *   non-title capabilities discovered in the same `ExperienceUnit`, in
 *   extraction order — the same adjacency `complements` already uses,
 *   captured as a second, distinctly-typed edge rather than by
 *   repurposing `complements` itself (see the module doc comment).
 * - **Cross-unit** (`SEQUENCE_CROSS_UNIT_CONFIDENCE`, strictly lower):
 *   a unit's last non-title capability to the next sibling unit's first
 *   non-title capability, where "next sibling" means the literally next
 *   unit by `provenance.blockIndexRange` among units sharing the same
 *   `hierarchy.parentUnitId` (the same section) — this is what recovers
 *   ordering across a real bulleted list once each bullet becomes its
 *   own `ExperienceUnit` (post Finding-B's list-marker fix), which
 *   within-unit adjacency alone cannot see. A unit that produced zero
 *   non-title capabilities breaks the chain at that point rather than
 *   being skipped past — two units are only ever sequenced when they are
 *   the literal next sibling of one another, never bridged over an
 *   intervening capability-less unit (a heading, an unrecognized block),
 *   since that unit's presence means the two are not actually adjacent
 *   in the source.
 *
 * Both are strictly below every named relation type's confidence
 * (`complements` 0.5, `depends_on` 0.55, `extends` 0.6) by design: this
 * signal claims only "appeared in this order," a weaker claim than any
 * of those, and `@xo/workflow-composer` treats it accordingly — see
 * `packages/workflow-composer/src/precedence.ts`'s `SEQUENCE_EDGE_KINDS`
 * (kept structurally separate from `PRECEDENCE_EDGE_KINDS`, the logical-
 * dependency table) and `compose.ts`'s `'source_derived_ordering'` gap.
 *
 * P0.9A area E (Specification Recovery) addendum: the cross-unit pass
 * (3b, below) no longer emits this edge between two adjacent sibling
 * units that are *both* bulleted (`ExperienceUnit.listKind ===
 * 'unordered'`). A bullet marker never claimed a sequence in the first
 * place — the real Aastha.pdf fixture bullets its description of three
 * parallel systems (CRM / Reconciliation Tool / Tally Prime) under
 * "1. Operational System Architecture," and, separately, bullets
 * genuine alternatives elsewhere (e.g. "Cashless" / "Reimbursement"
 * settlement modes) — neither is a procedure, and asserting
 * `custom:sequence` between them was an unearned association even at
 * this signal's already-weakest confidence tier. A numbered
 * (`'ordered'`) sibling pair, or a list item adjacent to a non-list
 * unit, is unaffected — this narrows the signal, it does not remove it.
 */
export const SEQUENCE_RELATION_TYPE: CapabilityRelationType = 'custom:sequence';
const SEQUENCE_WITHIN_UNIT_CONFIDENCE = 0.45;
const SEQUENCE_CROSS_UNIT_CONFIDENCE = 0.35;

function unitProvenance(unit: { readonly id: string; readonly provenance: { readonly documentPath: string; readonly pages: readonly number[]; readonly sectionPath: readonly string[] } }, confidence: number): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange: undefined,
    confidence,
  };
}

/**
 * Builds every final `CapabilityRelationship`, from three sources, then
 * returns the final `capabilities` array with `dependencies` populated
 * from the resulting `depends_on` edges (a two-phase split — merge, then
 * relationships-and-dependencies — matching Stage 3's
 * `documentReferences` and Stage 4's edge-building precedent exactly):
 *
 * 1. **Extractor-supplied edges** — resolved from local ids to final
 *    capability ids (the mechanism is real and exercised by tests, even
 *    though neither shipped extractor populates any today — see the
 *    package README).
 * 2. **`extends`**: a unit's verb- or snippet-derived capabilities extend
 *    that same unit's title-derived capability, when one exists (the
 *    specific elaborates the general).
 * 3. **`complements`**: within a unit, each non-title capability
 *    complements the immediately preceding non-title capability found in
 *    the same unit (sequential co-occurrence).
 * 4. **`depends_on`**: content-mention — a capability whose description
 *    textually mentions another capability's canonical name.
 */
export function buildCapabilityRelationships(
  perUnit: readonly PerUnitCapabilityExtraction[],
  mergeResult: CapabilityMergeResult,
): { readonly capabilities: readonly Capability[]; readonly relationships: readonly CapabilityRelationship[] } {
  interface EdgeAccumulator {
    readonly type: CapabilityRelationType;
    readonly fromId: CapabilityId;
    readonly toId: CapabilityId;
    confidenceSum: number;
    count: number;
    readonly provenance: KnowledgeProvenance[];
  }
  const accumulators = new Map<string, EdgeAccumulator>();

  const pushEdge = (type: CapabilityRelationType, fromId: CapabilityId | undefined, toId: CapabilityId | undefined, confidence: number, provenance: KnowledgeProvenance): void => {
    if (fromId === undefined || toId === undefined || fromId === toId) return;
    const key = `${type}\u0000${fromId}\u0000${toId}`;
    const existing = accumulators.get(key);
    if (existing) {
      existing.confidenceSum += confidence;
      existing.count += 1;
      existing.provenance.push(provenance);
    } else {
      accumulators.set(key, { type, fromId, toId, confidenceSum: confidence, count: 1, provenance: [provenance] });
    }
  };

  // 1. Extractor-supplied edges
  for (const { unit, extraction } of perUnit) {
    for (const ref of extraction.edges) {
      const fromId = mergeResult.resolveLocalId(unit.id, ref.fromLocalId);
      const toId = mergeResult.resolveLocalId(unit.id, ref.toLocalId);
      pushEdge(ref.type, fromId, toId, ref.confidence, ref.provenance);
    }
  }

  // 2 & 3. extends / complements / (within-unit) sequence, within each unit.
  // Also records each unit's first/last non-title capability id, in extraction
  // order, for the cross-unit sequence pass below — a unit that resolves no
  // non-title capability id at all is simply absent from this map, which is
  // exactly how it is excluded from cross-unit sequencing (see 3b).
  interface UnitCapabilityEndpoints {
    readonly firstId: CapabilityId;
    readonly lastId: CapabilityId;
  }
  const endpointsByUnitId = new Map<string, UnitCapabilityEndpoints>();

  for (const { unit, extraction } of perUnit) {
    const titleCandidate = extraction.capabilities.find((c) => c.localId === 'title');
    const titleId = titleCandidate ? mergeResult.resolveLocalId(unit.id, 'title') : undefined;
    const others = extraction.capabilities.filter((c) => c.localId !== 'title');

    let previousId: CapabilityId | undefined;
    let firstId: CapabilityId | undefined;
    for (const candidate of others) {
      const candidateId = mergeResult.resolveLocalId(unit.id, candidate.localId);
      if (titleId !== undefined) {
        pushEdge('extends', candidateId, titleId, EXTENDS_CONFIDENCE, unitProvenance(unit, EXTENDS_CONFIDENCE));
      }
      if (previousId !== undefined) {
        pushEdge('complements', candidateId, previousId, COMPLEMENTS_CONFIDENCE, unitProvenance(unit, COMPLEMENTS_CONFIDENCE));
        pushEdge(SEQUENCE_RELATION_TYPE, previousId, candidateId, SEQUENCE_WITHIN_UNIT_CONFIDENCE, unitProvenance(unit, SEQUENCE_WITHIN_UNIT_CONFIDENCE));
      }
      if (firstId === undefined) firstId = candidateId;
      previousId = candidateId;
    }
    if (firstId !== undefined && previousId !== undefined) {
      endpointsByUnitId.set(unit.id, { firstId, lastId: previousId });
    }
  }

  // 3b. Cross-unit sequence: connects the last non-title capability of a unit
  // to the first non-title capability of the *next* unit in the same section
  // (same `hierarchy.parentUnitId`), ordered by `provenance.blockIndexRange`.
  // This is what recovers step ordering across a real bulleted procedure once
  // each bullet is its own ExperienceUnit — within-unit adjacency (above)
  // cannot see across a unit boundary at all. Deliberately restricted to
  // *direct* section-mates (siblings sharing one parent), never a document-
  // wide or cross-section chain, and only between units that each resolved
  // at least one real non-title capability — a unit with zero is skipped
  // entirely rather than bridged over.
  interface UnitPositionEntry {
    readonly unitId: string;
    readonly blockStart: number;
  }
  const positionsByParent = new Map<string, UnitPositionEntry[]>();
  const unitById = new Map<string, PerUnitCapabilityExtraction['unit']>();
  for (const { unit } of perUnit) {
    unitById.set(unit.id, unit);
    // Units with no real content (whitespace-only — e.g. a bare bullet-glyph
    // remnant left behind at the end of a wrapped line, see list-marker.ts's
    // doc comment) carry no information at all and are excluded from the
    // position list entirely, rather than included as a chain-breaker: an
    // empty unit is not "there is unrelated content here," it is nothing.
    // A unit with *real* content but no recognized capability (e.g. a plain
    // section heading) still takes its place in the list below and DOES
    // break the chain — see the "does not participate ... is not bridged
    // over" doc comment above.
    if (unit.content.trim().length === 0) continue;
    const parentKey = `${unit.provenance.documentPath}\u0000${unit.hierarchy.parentUnitId ?? '<root>'}`;
    const list = positionsByParent.get(parentKey) ?? [];
    list.push({ unitId: unit.id, blockStart: unit.provenance.blockIndexRange[0] });
    positionsByParent.set(parentKey, list);
  }
  for (const entries of positionsByParent.values()) {
    entries.sort((a, b) => a.blockStart - b.blockStart);
    for (let i = 0; i < entries.length - 1; i += 1) {
      const prevUnit = unitById.get(entries[i]!.unitId);
      const nextUnit = unitById.get(entries[i + 1]!.unitId);
      const prevEndpoints = endpointsByUnitId.get(entries[i]!.unitId);
      const nextEndpoints = endpointsByUnitId.get(entries[i + 1]!.unitId);
      if (!prevUnit || !nextUnit || !prevEndpoints || !nextEndpoints) continue; // a capability-less unit anywhere in the pair breaks this link — never bridged over
      // P0.9A area E (Specification Recovery): two adjacent *bulleted*
      // siblings (both `listKind === 'unordered'`) never get a
      // `custom:sequence` edge between them — the source author's own
      // marker never claimed an order for these two items (enumeration,
      // alternatives, or parallel items, not a procedure), so asserting
      // "before/after" here would be an unearned association, not a
      // recovered one. Any other combination (either side `'ordered'`,
      // or either side not a list item at all — e.g. a numbered step
      // followed by plain prose) is left exactly as before: this
      // exclusion only fires on a *proven* unordered/unordered pair.
      if (prevUnit.listKind === 'unordered' && nextUnit.listKind === 'unordered') continue;
      pushEdge(SEQUENCE_RELATION_TYPE, prevEndpoints.lastId, nextEndpoints.firstId, SEQUENCE_CROSS_UNIT_CONFIDENCE, unitProvenance(prevUnit, SEQUENCE_CROSS_UNIT_CONFIDENCE));
    }
  }

  // 4. Content-mention depends_on — scanned once over the final merged capabilities themselves, not per source unit (a capability's description already carries everything relevant; it needs no additional per-unit context here).
  for (const fromCap of mergeResult.capabilities) {
    for (const toCap of mergeResult.capabilities) {
      if (fromCap.id === toCap.id) continue;
      if (toCap.canonicalName.length < MIN_MENTION_LABEL_LENGTH) continue;
      if (fromCap.description.includes(toCap.canonicalName)) {
        const provenance: KnowledgeProvenance = fromCap.provenance[0] ?? { experienceUnitId: '', documentPath: '', pages: [], sectionPath: [], charOffsetRange: undefined, confidence: DEPENDS_ON_CONFIDENCE };
        pushEdge('depends_on', fromCap.id, toCap.id, DEPENDS_ON_CONFIDENCE, provenance);
      }
    }
  }

  const relationships: CapabilityRelationship[] = [...accumulators.values()].map((acc) => ({
    id: computeCapabilityRelationshipId(acc.type, acc.fromId, acc.toId),
    type: acc.type,
    fromCapabilityId: acc.fromId,
    toCapabilityId: acc.toId,
    confidence: Math.round((acc.confidenceSum / acc.count) * 1000) / 1000,
    provenance: acc.provenance,
  }));
  relationships.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const dependenciesByCapabilityId = new Map<CapabilityId, CapabilityId[]>();
  for (const rel of relationships) {
    if (rel.type !== 'depends_on') continue;
    const list = dependenciesByCapabilityId.get(rel.fromCapabilityId) ?? [];
    list.push(rel.toCapabilityId);
    dependenciesByCapabilityId.set(rel.fromCapabilityId, list);
  }

  const capabilities = mergeResult.capabilities.map((cap) => ({ ...cap, dependencies: dependenciesByCapabilityId.get(cap.id) ?? [] }));

  return { capabilities, relationships };
}

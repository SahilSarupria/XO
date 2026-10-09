import type { DraftExperienceUnit } from './unit-builder.js';
import { computeRelationshipId } from './unit-id.js';
import type { ExperienceUnit, ExperienceUnitId, ExperienceUnitRelationship, RelationshipGraph } from './types.js';

const EXTENDS_CONFIDENCE = 0.7;
const DEFINES_CONFIDENCE = 0.8;
const SUPPORTS_CONFIDENCE = 0.75;
const REFERENCES_CONFIDENCE = 0.6;

function makeRelationship(type: ExperienceUnitRelationship['type'], fromUnitId: ExperienceUnitId, toUnitId: ExperienceUnitId, confidence: number): ExperienceUnitRelationship {
  return { id: computeRelationshipId(type, fromUnitId, toUnitId), type, fromUnitId, toUnitId, confidence };
}

/**
 * Computes every deterministic relationship this stage is confident
 * enough to assert, from the whole document's draft units:
 *
 * - `extends`: every unit -> its `hierarchy.parentUnitId` (structural, always present when a parent exists).
 * - `defines`: a `definition` unit -> every other unit whose content contains that exact defined term.
 * - `supports`: an `example` unit -> the nearest preceding non-example unit in the same section.
 * - `references`: any unit -> the anchor unit of another section, when that section's heading text appears in this unit's content.
 *
 * `depends_on`, `contradicts`, `requires`, `implements`, and `explains`
 * are valid `RelationType`s this stage's model supports but does not
 * itself populate — see this package's README for why manufacturing
 * those deterministically here would overreach past what font size,
 * position, and shallow lexical cues can actually support.
 */
export function buildRelationships(draftUnits: readonly DraftExperienceUnit[]): { readonly units: readonly ExperienceUnit[]; readonly relationshipGraph: RelationshipGraph } {
  const relationships: ExperienceUnitRelationship[] = [];
  const documentReferencesByUnitId = new Map<string, string[]>();
  for (const unit of draftUnits) documentReferencesByUnitId.set(unit.id, []);

  // extends
  for (const unit of draftUnits) {
    if (unit.hierarchy.parentUnitId !== undefined) {
      relationships.push(makeRelationship('extends', unit.id, unit.hierarchy.parentUnitId, EXTENDS_CONFIDENCE));
    }
  }

  // defines
  const definitionUnits = draftUnits.filter((u) => u.definedTerm !== undefined);
  for (const definitionUnit of definitionUnits) {
    const term = definitionUnit.definedTerm!;
    for (const candidate of draftUnits) {
      if (candidate.id === definitionUnit.id) continue;
      if (candidate.content.includes(term)) {
        relationships.push(makeRelationship('defines', definitionUnit.id, candidate.id, DEFINES_CONFIDENCE));
      }
    }
  }

  // supports (example -> nearest preceding non-example unit in the same section)
  const lastNonExampleBySectionKey = new Map<string, ExperienceUnitId>();
  for (const unit of draftUnits) {
    const sectionKey = unit.provenance.sectionPath.join(' / ');
    if (unit.semanticType === 'example') {
      const target = lastNonExampleBySectionKey.get(sectionKey);
      if (target !== undefined) {
        relationships.push(makeRelationship('supports', unit.id, target, SUPPORTS_CONFIDENCE));
      }
    } else {
      lastNonExampleBySectionKey.set(sectionKey, unit.id);
    }
  }

  // references (heading-text mention -> that section's anchor unit)
  const anchorsByHeadingTitle = new Map<string, ExperienceUnitId>();
  for (const unit of draftUnits) {
    if (unit.isSectionAnchor && unit.headingTitle !== undefined) {
      anchorsByHeadingTitle.set(unit.headingTitle, unit.id);
    }
  }
  for (const unit of draftUnits) {
    for (const [headingTitle, anchorId] of anchorsByHeadingTitle) {
      if (anchorId === unit.id) continue; // a heading never "references" its own section
      if (unit.content.includes(headingTitle)) {
        relationships.push(makeRelationship('references', unit.id, anchorId, REFERENCES_CONFIDENCE));
        documentReferencesByUnitId.get(unit.id)!.push(headingTitle);
      }
    }
  }

  const units: ExperienceUnit[] = draftUnits.map((draft) => ({
    id: draft.id,
    title: draft.title,
    headingTitle: draft.headingTitle,
    semanticType: draft.semanticType,
    content: draft.content,
    provenance: draft.provenance,
    hierarchy: draft.hierarchy,
    confidence: draft.confidence,
    relationships: relationships.filter((r) => r.fromUnitId === draft.id),
    documentReferences: documentReferencesByUnitId.get(draft.id) ?? [],
    metadata: {},
    ...(draft.structuredFields !== undefined ? { structuredFields: draft.structuredFields } : {}),
    ...(draft.isTableQuarantined !== undefined ? { isTableQuarantined: draft.isTableQuarantined } : {}),
    ...(draft.listKind !== undefined ? { listKind: draft.listKind } : {}),
  }));

  return { units, relationshipGraph: { relationships } };
}

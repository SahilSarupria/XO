import type { DocumentBlock, DocumentSection, StructuredFieldValue } from '../document/types.js';
import { AMBIGUITY_CONFIDENCE_THRESHOLD, type BoundaryAmbiguityResolver } from './boundary-resolver.js';
import { classifyBlock } from './semantic-type-classifier.js';
import { synthesizeTitle } from './title.js';
import { computeExperienceUnitId } from './unit-id.js';
import type { ExperienceUnitHierarchy, ExperienceUnitId, ExperienceUnitProvenance, SemanticType } from './types.js';

/** A unit as built by this module — everything except `relationships`/`documentReferences`, which need the *whole document's* units and section headings and so are computed afterward, in relationship-builder.ts. */
export interface DraftExperienceUnit {
  readonly id: ExperienceUnitId;
  readonly title: string;
  readonly semanticType: SemanticType;
  readonly content: string;
  readonly provenance: ExperienceUnitProvenance;
  readonly hierarchy: ExperienceUnitHierarchy;
  readonly confidence: number;
  readonly definedTerm: string | undefined; // carried through for relationship-builder.ts's `defines` edges; not part of the final ExperienceUnit shape
  /** True for a section's first unit when it borrowed its title from a real `DocumentSection.heading` — the unit relationship-builder.ts resolves a heading-text mention to. */
  readonly isSectionAnchor: boolean;
  readonly headingTitle: string | undefined; // the borrowed heading text itself, when isSectionAnchor is true
  /** Present only when at least one of this group's blocks carries a `structuredField` (i.e. came from the structured CSV/JSON frontend); absent otherwise. Preserved uninterpreted, in source iteration order. */
  readonly structuredFields: readonly StructuredFieldValue[] | undefined;
  /**
   * P0.9A area C (Table Detection + Quarantine). True when this unit's
   * only constituent block is a `TableRowBlock` (always true today,
   * since `table_row` is `isAlwaysOwnGroup` in `groupBlocks`, same as
   * `list_item`/`footnote` — checked structurally here rather than
   * hardcoded to that assumption, so this stays correct if that grouping
   * rule is ever revisited). Knowledge/capability extraction (Stage 4/5)
   * must skip a unit with this set — see `knowledge/rule-based-
   * extractor.ts` and `capabilities/rule-based-extractor.ts` — rather
   * than treat its cell text as ordinary prose. The unit itself, its
   * `content` (space-joined cell text) and full provenance are still
   * built and preserved exactly like any other unit: this field gates
   * *interpretation*, not *existence* — "preserved as source/document
   * structure... excluded from ordinary prose semantic extraction," per
   * this milestone's own preferred architecture.
   */
  readonly isTableQuarantined?: boolean;
  /**
   * P0.9A area E (Specification Recovery). Set only when this group's
   * single block is a `ListItemBlock` (list items are always their own
   * group — `isAlwaysOwnGroup` below), carrying that block's `listKind`
   * through unchanged. Exists so `capabilities/relationship-builder.ts`
   * can tell a genuinely author-ordered step (`'ordered'`: "1.", "a)")
   * apart from a merely-enumerated one (`'unordered'`: "-", "•") before
   * asserting a `custom:sequence` edge between two adjacent siblings —
   * see that file's own doc comment for why this distinction turned out
   * to matter for a real fixture (Aastha.pdf's bulleted, *parallel*
   * system descriptions under "1. Operational System Architecture",
   * which are not sequential steps despite sitting adjacent in the
   * document). Deliberately NOT included in `computeExperienceUnitId`'s
   * hash input (see `unit-id.ts`) — it is derived, source-structural
   * metadata, not part of what makes this unit's identity unique, the
   * same treatment `isTableQuarantined` already gets.
   */
  readonly listKind: 'ordered' | 'unordered' | undefined;
}

function textOf(block: DocumentBlock): string {
  return block.kind === 'table_row' ? block.cells.join(' ') : block.text;
}

interface BlockGroup {
  readonly blocks: readonly DocumentBlock[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly semanticType: SemanticType;
  readonly confidence: number;
  readonly definedTerm: string | undefined;
}

/**
 * Groups a section's own blocks (never its subsections' blocks — those
 * are handled by the recursive call in `buildExperienceUnitsForSection`)
 * into boundary-detected runs: a list item or a footnote is always its
 * own group (each is already a distinct enumerated point or aside);
 * everything else is grouped with the immediately preceding group only
 * if that group is also a plain paragraph/table run *and* classifies to
 * the same semantic type — a type change is treated as a topic
 * transition, per this stage's "boundary detection, not text splitting"
 * design goal.
 */
async function groupBlocks(blocks: readonly DocumentBlock[], resolver: BoundaryAmbiguityResolver): Promise<readonly BlockGroup[]> {
  const groups: BlockGroup[] = [];
  let current: { blocks: DocumentBlock[]; startIndex: number; semanticType: SemanticType; confidenceSum: number; definedTerm: string | undefined } | undefined;

  const flush = (endIndex: number): void => {
    if (!current) return;
    groups.push({
      blocks: current.blocks,
      startIndex: current.startIndex,
      endIndex,
      semanticType: current.semanticType,
      confidence: current.confidenceSum / current.blocks.length,
      definedTerm: current.definedTerm,
    });
    current = undefined;
  };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const initial = classifyBlock(block);
    const classification =
      initial.confidence < AMBIGUITY_CONFIDENCE_THRESHOLD
        ? await resolver.resolve({ ruleBasedType: initial.semanticType, ruleBasedConfidence: initial.confidence, text: textOf(block) })
        : { semanticType: initial.semanticType, confidence: initial.confidence };

    const isAlwaysOwnGroup = block.kind === 'list_item' || block.kind === 'footnote' || block.kind === 'table_row';

    if (isAlwaysOwnGroup) {
      flush(i - 1);
      groups.push({ blocks: [block], startIndex: i, endIndex: i, semanticType: classification.semanticType, confidence: classification.confidence, definedTerm: initial.definedTerm });
      continue;
    }

    const previousBlock = current?.blocks[current.blocks.length - 1];
    const canExtend = current !== undefined && previousBlock !== undefined && previousBlock.kind !== 'list_item' && previousBlock.kind !== 'footnote' && previousBlock.kind !== 'table_row' && current.semanticType === classification.semanticType;

    if (canExtend && current) {
      current.blocks.push(block);
      current.confidenceSum += classification.confidence;
      if (current.definedTerm === undefined) current.definedTerm = initial.definedTerm;
    } else {
      flush(i - 1);
      current = { blocks: [block], startIndex: i, semanticType: classification.semanticType, confidenceSum: classification.confidence, definedTerm: initial.definedTerm };
    }
  }
  flush(blocks.length - 1);

  return groups;
}

export interface SectionBuildResult {
  readonly units: readonly DraftExperienceUnit[];
  /** The id of this section's first own unit, or (if it built none) the `parentAnchorId` passed in — bubbled up so a subsection with no unit-bearing parent section still gets a sensible ancestor. */
  readonly anchorId: ExperienceUnitId | undefined;
}

/**
 * Recursively builds draft units for one section and all its
 * subsections. `sectionPath` is the heading trail down to (and
 * including, once entered) this section; `parentAnchorId` is the id
 * subsection units should point their `hierarchy.parentUnitId` at.
 */
export async function buildExperienceUnitsForSection(
  section: DocumentSection,
  documentPath: string,
  sectionPath: readonly string[],
  parentAnchorId: ExperienceUnitId | undefined,
  resolver: BoundaryAmbiguityResolver,
): Promise<SectionBuildResult> {
  const groups: BlockGroup[] = [...(await groupBlocks(section.blocks, resolver))];
  const depth = sectionPath.length;

  // A section whose heading has no body blocks of its own (a heading immediately
  // followed only by subsections, with no intro text) still needs an anchor unit —
  // otherwise its heading is unaddressable: no `extends` target for its subsections,
  // no unit a `references` mention of that heading could point at.
  if (groups.length === 0 && section.heading !== undefined) {
    const heading = section.heading;
    groups.push({ blocks: [heading], startIndex: -1, endIndex: -1, semanticType: 'general', confidence: 1, definedTerm: undefined });
  }

  const ids = groups.map((group) => {
    const content = group.blocks.map(textOf).join('\n\n');
    return computeExperienceUnitId(documentPath, sectionPath, [group.startIndex, group.endIndex], content);
  });

  const ownUnits: DraftExperienceUnit[] = groups.map((group, groupIndex) => {
    const content = group.blocks.map(textOf).join('\n\n');
    const title = groupIndex === 0 && section.heading ? section.heading.text : synthesizeTitle(content);
    const structuredFieldsForGroup = group.blocks.filter((b): b is DocumentBlock & { kind: 'paragraph'; structuredField: StructuredFieldValue } => b.kind === 'paragraph' && b.structuredField !== undefined).map((b) => b.structuredField);
    const structuredFields = structuredFieldsForGroup.length > 0 ? structuredFieldsForGroup : undefined;
    const pages = [...new Set(group.blocks.map((b) => b.provenance.page))];
    const soleBlock = group.blocks.length === 1 ? group.blocks[0] : undefined;
    const listKind = soleBlock !== undefined && soleBlock.kind === 'list_item' ? soleBlock.listKind : undefined;
    const provenance: ExperienceUnitProvenance = {
      documentPath,
      pages,
      sectionPath,
      blockProvenance: group.blocks.map((b) => b.provenance),
      blockIndexRange: [group.startIndex, group.endIndex],
    };
    // The section's own first unit ("anchor") points at the enclosing section's anchor; every other unit in this section points at THIS section's own anchor (ids[0]) instead — so units within one section form a shallow star around their section's anchor, and only anchors chain up the document's heading hierarchy.
    const parentUnitId = groupIndex === 0 ? parentAnchorId : ids[0];
    const isSectionAnchor = groupIndex === 0 && section.heading !== undefined;
    return {
      id: ids[groupIndex]!,
      title,
      semanticType: group.semanticType,
      content,
      provenance,
      hierarchy: { depth, parentUnitId, siblingUnitIds: [] }, // siblingUnitIds filled in below, once every unit in this section is known
      confidence: group.confidence,
      definedTerm: group.definedTerm,
      isSectionAnchor,
      headingTitle: isSectionAnchor ? section.heading!.text : undefined,
      structuredFields,
      isTableQuarantined: group.blocks.every((b) => b.kind === 'table_row'),
      listKind,
    };
  });

  const withSiblings: DraftExperienceUnit[] = ownUnits.map((unit) => ({
    ...unit,
    hierarchy: { ...unit.hierarchy, siblingUnitIds: ownUnits.filter((u) => u.id !== unit.id).map((u) => u.id) },
  }));

  const anchorId = withSiblings[0]?.id ?? parentAnchorId;

  const allUnits: DraftExperienceUnit[] = [...withSiblings];
  for (const subsection of section.subsections) {
    const subsectionPath = subsection.heading ? [...sectionPath, subsection.heading.text] : sectionPath;
    const result = await buildExperienceUnitsForSection(subsection, documentPath, subsectionPath, anchorId, resolver);
    allUnits.push(...result.units);
  }

  return { units: allUnits, anchorId };
}

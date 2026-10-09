import type { Brand } from '@xo/types';
import type { Provenance, StructuredFieldValue } from '../document/types.js';

export type ExperienceUnitId = Brand<string, 'ExperienceUnitId'>;

/**
 * What kind of professional idea a unit represents. Deliberately open-
 * ended (`custom:<name>` — the same pattern `@xo/xoir`'s `XoirNodeKind`
 * uses) so this generalizes past legal documents: a medical-record
 * compiler frontend or an engineering-runbook compiler frontend can mint
 * its own semantic types without forking this file.
 */
export type KnownSemanticType = 'definition' | 'obligation' | 'right' | 'exception' | 'example' | 'explanatory_note' | 'clause' | 'general';
export type SemanticType = KnownSemanticType | `custom:${string}`;

/** Known relationship kinds an Experience Unit can have to another (the compiler spec's example list). Open-ended via `custom:<name>`, matching `@xo/xoir`'s `XoirEdgeKind` — these become XOIR edges once Stage 10 runs, but are computed here, before any XOIR graph exists. */
export type KnownRelationType = 'depends_on' | 'references' | 'extends' | 'contradicts' | 'defines' | 'explains' | 'requires' | 'implements' | 'supports';
export type RelationType = KnownRelationType | `custom:${string}`;

export interface ExperienceUnitRelationship {
  readonly id: string;
  readonly type: RelationType;
  readonly fromUnitId: ExperienceUnitId;
  readonly toUnitId: ExperienceUnitId;
  readonly confidence: number;
}

/** Everything about where a unit came from and how it sits in the document's structure — the compiler spec's provenance and hierarchy requirements, combined into one place since they're populated together and always consumed together. */
export interface ExperienceUnitProvenance {
  readonly documentPath: string;
  readonly pages: readonly number[];
  /** Heading trail from the document root to this unit's enclosing section, e.g. `["Article 1: Definitions", "1.1 Confidential Information"]`. */
  readonly sectionPath: readonly string[];
  /** Per-source-block provenance (page + y-range) for every block merged into this unit — see `../document/types.ts`'s `Provenance`. */
  readonly blockProvenance: readonly Provenance[];
  /** Index range, within its enclosing section's flat block list, of the blocks merged into this unit — the compiler spec's "paragraph boundaries" requirement. */
  readonly blockIndexRange: readonly [number, number];
}

export interface ExperienceUnitHierarchy {
  readonly depth: number; // 0 = document root level
  readonly parentUnitId: ExperienceUnitId | undefined;
  readonly siblingUnitIds: readonly ExperienceUnitId[]; // other units in the same section, reading order, excluding self
}

/**
 * A first-class compiler artifact representing one coherent professional
 * idea — never just "some text." This is the canonical input every
 * Stage 4-9 AI extraction call consumes (via `@xo/ai-core`), and is
 * designed to be reusable outside this compiler package entirely (a
 * future non-PDF frontend produces the same shape).
 */
export interface ExperienceUnit {
  readonly id: ExperienceUnitId;
  readonly title: string;
  /**
   * The exact heading text this unit's `title` was borrowed from, when
   * (and only when) `title` is a genuine authored heading rather than a
   * title synthesized from this unit's own content (`synthesizeTitle` in
   * `unit-builder.ts` — the first ~8 words of `content`, used for every
   * unit but a section's first). `undefined` whenever `title` was
   * synthesized. `title` and `headingTitle` are identical strings when
   * both are present; this field exists purely so a consumer (e.g.
   * `rule-based-extractor.ts`'s title/category-keyword capability
   * detection) can tell "this word appears in an author-written heading"
   * apart from "this word happens to appear in the unit's own leading
   * prose" — ordinary prose synthesizing a category keyword into its
   * `title` (e.g. "Reconcile the invoice balance...") must not be
   * mistaken for a genuine heading like "Brokerage Validation".
   */
  readonly headingTitle: string | undefined;
  readonly semanticType: SemanticType;
  readonly content: string;
  readonly provenance: ExperienceUnitProvenance;
  readonly hierarchy: ExperienceUnitHierarchy;
  readonly confidence: number;
  readonly relationships: readonly ExperienceUnitRelationship[];
  readonly documentReferences: readonly string[]; // section-heading-path strings this unit's content textually references
  readonly metadata: Readonly<Record<string, string>>;
  /** Present only when this unit was built from at least one structured (CSV/JSON) source-field block; absent for every other source. Preserved uninterpreted — no field name is treated as reserved vocabulary here. */
  readonly structuredFields?: readonly StructuredFieldValue[];
  /** P0.9A area C: see `unit-builder.ts`'s `DraftExperienceUnit.isTableQuarantined` doc comment — identical meaning, carried through unchanged by `relationship-builder.ts`. */
  readonly isTableQuarantined?: boolean;
  /** P0.9A area E (Specification Recovery): see `unit-builder.ts`'s `DraftExperienceUnit.listKind` doc comment. Present only when this unit's sole constituent block is a `ListItemBlock`; absent otherwise (a unit spanning multiple merged blocks, or a non-list unit, makes no single ordered/unordered claim). */
  readonly listKind?: 'ordered' | 'unordered';
}

export interface RelationshipGraph {
  readonly relationships: readonly ExperienceUnitRelationship[];
}

/** Stage 3's full output — NOT XOIR. The semantic intermediate representation Stages 4-9 consume, one level below the canonical `@xo/xoir` IR that Stage 10 ultimately produces from their output. */
export interface ExperienceDocument {
  readonly documentPath: string;
  readonly documentTitle: string | undefined;
  readonly units: readonly ExperienceUnit[];
  readonly relationshipGraph: RelationshipGraph;
}

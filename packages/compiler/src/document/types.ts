export interface Provenance {
  readonly page: number;
  /** Approximate bounding y-range (PDF user-space units, origin bottom-left) this block occupied — top (higher y) first. */
  readonly yRange: readonly [number, number];
}

/** A structured field's literal value, preserved without interpretation. CSV cells are always `string` (CSV has no native typing). A nested JSON object/array value is NOT recursively preserved here — it arrives already collapsed to a string by the structured frontend's existing `fieldToText` behavior. */
export type StructuredRawValue = string | number | boolean | null;

/** One field from a structured (CSV/JSON) source record, exactly as declared — no reserved-vocabulary interpretation of `fieldName`, no coercion of `rawValue` into a schema type. What `fieldName` or `rawValue` *mean* (a dependency list, a formula, a schema type) is a later semantic-realization decision, deliberately not made here. */
export interface StructuredFieldValue {
  readonly fieldName: string;
  readonly rawValue: StructuredRawValue;
}

export interface HeadingBlock {
  readonly kind: 'heading';
  readonly level: number; // 1 = largest/most prominent heading font size found in the document, increasing = smaller
  readonly text: string;
  readonly provenance: Provenance;
}

export interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly text: string;
  readonly provenance: Provenance;
  /** Present only when this block was created by the structured (CSV/JSON) source frontend from one field of a source record; absent for every other source. */
  readonly structuredField?: StructuredFieldValue;
}

export interface ListItemBlock {
  readonly kind: 'list_item';
  readonly marker: string; // e.g. "1.", "a)", "-", "•"
  /** Whether the source author's own marker claims a sequence ('ordered': "1.", "a)") or merely enumerates ('unordered': "-", "•") — see list-marker.ts's DetectedListMarker doc comment. P0.9A area E. */
  readonly listKind: 'ordered' | 'unordered';
  readonly text: string;
  readonly provenance: Provenance;
}

export interface TableRowBlock {
  readonly kind: 'table_row';
  readonly cells: readonly string[];
  readonly provenance: Provenance;
}

export interface FootnoteBlock {
  readonly kind: 'footnote';
  readonly text: string;
  readonly provenance: Provenance;
}

export type DocumentBlock = HeadingBlock | ParagraphBlock | ListItemBlock | TableRowBlock | FootnoteBlock;

/** A section is defined by a heading and nests every block/subsection that follows it until a heading of equal or higher prominence (lower or equal `level`) appears. The document root is an implicit, headingless top-level section. */
export interface DocumentSection {
  readonly heading: HeadingBlock | undefined; // undefined only for the synthetic document root
  readonly blocks: readonly DocumentBlock[];
  readonly subsections: readonly DocumentSection[];
}

export interface ParsedDocument {
  readonly root: DocumentSection;
  readonly bodyFontSizePt: number;
}

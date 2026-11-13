export interface Provenance {
  readonly page: number;
  /** Approximate bounding y-range (PDF user-space units, origin bottom-left) this block occupied — top (higher y) first. */
  readonly yRange: readonly [number, number];
  /**
   * UW-3 — present when the text was NOT read from the page's own text layer but recovered (OCR, vision): which tier recovered it, at
   * what confidence, and its cost class. Absent = read directly. It travels with the block into every unit built from it, so a claim
   * resting on recovered text can be told apart (and held to review) everywhere downstream.
   */
  readonly textSource?: {
    readonly kind: 'recovered';
    readonly tier: string;
    readonly confidence: number;
    readonly costClass?: 'free' | 'local' | 'model';
  };
}

/** A structured field's literal value, preserved without interpretation. CSV cells are always `string` (CSV has no native typing). A nested JSON object/array value is NOT recursively preserved here — it arrives already collapsed to a string by the structured frontend's existing `fieldToText` behavior. */
export type StructuredRawValue = string | number | boolean | null;

/** One field from a structured (CSV/JSON) source record, exactly as declared — no reserved-vocabulary interpretation of `fieldName`, no coercion of `rawValue` into a schema type. What `fieldName` or `rawValue` *mean* (a dependency list, a formula, a schema type) is a later semantic-realization decision, deliberately not made here. */
export interface StructuredFieldValue {
  readonly fieldName: string;
  readonly rawValue: StructuredRawValue;
  /** UW-3 — the cell the value came from (`B7`, `Clients!B7`), for tabular sources. Absent for JSON records and for empty cells. */
  readonly cellRef?: string;
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
  /**
   * UW-3b: this paragraph is one field of a fill-in form ("Owner: ____", "Goal | What should be true when this is
   * done?"): a label and, when printed, the hint or options shown in the value column. The author asks for a value here;
   * it is not a statement of fact or a rule.
   */
  readonly formField?: { readonly label: string; readonly hint?: string };
  /** UW-3b: the line(s) this paragraph came from held text in separate columns that were joined; meaning may be garbled. */
  readonly layoutSuspect?: true;
}

export interface ListItemBlock {
  readonly kind: 'list_item';
  readonly marker: string; // e.g. "1.", "a)", "-", "•"
  /** Whether the source author's own marker claims a sequence ('ordered': "1.", "a)") or merely enumerates ('unordered': "-", "•") — see list-marker.ts's DetectedListMarker doc comment. P0.9A area E. */
  readonly listKind: 'ordered' | 'unordered';
  readonly text: string;
  readonly provenance: Provenance;
  /** UW-3b: the item is a checklist entry (`[ ]`, `☑`), with the author's tick state. */
  readonly checkbox?: 'unchecked' | 'checked';
  /** UW-3b: the position the marker claims (`3.` → 3, `c)` → 3), when it claims one. */
  readonly ordinal?: number;
  /** UW-3b: a short title set apart from the item's body ("Never commit secrets." / "API keys stay in ..."). `text` stays the whole item. */
  readonly title?: string;
  readonly body?: string;
}

export interface TableRowBlock {
  readonly kind: 'table_row';
  readonly cells: readonly string[];
  readonly provenance: Provenance;
  /**
   * UW-3b: how the row was recovered. `wrapped` = rebuilt from a table whose cells wrap over several physical lines
   * (each cell is that column's lines joined). Absent for a row read from one physical line.
   */
  readonly reconstruction?: 'wrapped';
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

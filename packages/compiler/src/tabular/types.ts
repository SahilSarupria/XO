/**
 * UW-3 — record-level tabular data. A workbook or CSV file becomes RECORD SETS: a header, typed columns and records whose every value
 * keeps the exact text it was stored as and the cell it came from. Nothing is converted on the way in: a column has a DECLARED type,
 * worked out from what the cells say, and a consumer converts explicitly if it wants to. Anything the reader could not settle (no header
 * row, merged cells, a date written in an ambiguous order, a formula's cached result) is a finding, never a guess.
 */

/** How a single cell was stored. CSV cells are always `string` (CSV has no types); the column's declared type says what they look like. */
export type CellKind = 'string' | 'number' | 'boolean' | 'date' | 'error';

export interface TabularCell {
  /** A1 reference, with the sheet for workbooks: `Clients!B7`; `B7` for CSV. */
  readonly ref: string;
  /** 1-based row number in the sheet (CSV: the record's position in the file, not its physical line). */
  readonly row: number;
  /** 1-based column number. */
  readonly column: number;
  /** Exactly what was stored: the text, the number literal (`45291`, never reformatted), `1`/`0` for a boolean, `#N/A` for an error. */
  readonly raw: string;
  readonly kind: CellKind;
  /** The formula text when the cell has one. It is never evaluated: `raw` is the result the workbook itself cached. */
  readonly formula?: string;
  /** The cell's number format code, when the workbook gives it one other than General. */
  readonly numberFormat?: string;
  /**
   * Only for `kind: 'date'`: the cell's own number format declares a date, so the serial is read in the workbook's date system. The
   * serial stays in `raw`; `iso` is that reading (wall-clock time, no time zone: spreadsheets have none).
   */
  readonly date?: { readonly serial: number; readonly system: 1900 | 1904; readonly iso: string };
  /** CSV only: the physical line the cell's record starts on (records can span lines inside quotes). */
  readonly line?: number;
}

/** One sheet (or a whole CSV file) as stored: rows of cells, empty cells absent. */
export interface SheetGrid {
  /** Sheet name for workbooks; undefined for CSV. */
  readonly name?: string;
  /** 1-based position in the workbook (1 for CSV). */
  readonly index: number;
  /** Non-empty rows in ascending row order; each row's cells in ascending column order. */
  readonly rows: readonly { readonly row: number; readonly cells: readonly TabularCell[] }[];
  /** Merged ranges (`A1:C1`). Only the top-left cell of a merge holds a value; the reader never copies it into the others. */
  readonly merges: readonly string[];
  /** Hidden sheets are read like any other and marked, so a consumer can decide whether hidden data counts. */
  readonly hidden?: boolean;
}

/**
 * The type a column's values have, from the values themselves. `mixed` means more than one kind appears (the counts say which);
 * `empty` means no value at all. Leading-zero digit strings (`00123`) count as text: they are identifiers, and reading them as numbers
 * would lose the zeros.
 */
export type DeclaredType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'error' | 'mixed' | 'empty';

/** What one value looks like, for typing a column. */
export type ValueClass = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'error';

export interface TabularColumn {
  /** 1-based column number in the sheet. */
  readonly column: number;
  /** Column letter(s): `A`, `AB`. */
  readonly letter: string;
  /** Header text, or `Column B` when the table has no detected header (then `headerRef` is absent). */
  readonly header: string;
  readonly headerRef?: string;
  readonly declaredType: DeclaredType;
  /** How many values of each class the column holds (empty cells are not counted). */
  readonly counts: Readonly<Partial<Record<ValueClass, number>>>;
}

export interface TabularRecord {
  /** 1-based row number of the record (CSV: record position). */
  readonly row: number;
  /** Values keyed by column number; a column with no value in this record is absent. */
  readonly cells: Readonly<Record<number, TabularCell>>;
}

export type TabularFindingCode =
  | 'HEADER_NOT_FOUND'
  | 'DUPLICATE_HEADER'
  | 'EMPTY_HEADER'
  | 'TITLE_ROWS'
  | 'MERGED_CELLS'
  | 'VALUES_OUTSIDE_HEADER'
  | 'MIXED_TYPES'
  | 'AMBIGUOUS_DATE_FORMAT'
  | 'NUMBER_WITH_SEPARATORS'
  | 'FORMULA_RESULTS'
  | 'ERROR_VALUES'
  | 'STRAY_QUOTE'
  | 'HIDDEN_SHEET'
  | 'FICTITIOUS_DATE';

export interface TabularFinding {
  readonly code: TabularFindingCode;
  /** The cell, range or column the finding is about, when it has one. */
  readonly ref?: string;
  readonly message: string;
}

/** One table found in a sheet: its header, typed columns and records. A sheet can hold several, separated by blank rows. */
export interface RecordSet {
  /** Stable within the source: `Clients#1`, or `#1` for CSV. */
  readonly id: string;
  readonly sheet?: string;
  /** The header row, or undefined when none could be identified (then columns are named by letter). */
  readonly headerRow?: number;
  /** Why this row was taken as the header (shown to a reviewer; never silently assumed). */
  readonly headerEvidence?: string;
  /** Single-cell lines above the header (a report title, a date line), kept as text. */
  readonly titles: readonly TabularCell[];
  readonly columns: readonly TabularColumn[];
  readonly records: readonly TabularRecord[];
  readonly findings: readonly TabularFinding[];
}

export interface TabularSource {
  readonly format: 'xlsx' | 'csv';
  readonly sheets: readonly SheetGrid[];
  readonly recordSets: readonly RecordSet[];
  /** Workbook-level findings (hidden sheets, the 1900 leap-year bug) and CSV parse findings. */
  readonly findings: readonly TabularFinding[];
}

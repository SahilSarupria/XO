/**
 * Resource limits for tabular input (UW-3, plan "resource limits on every binary frontend"). A file beyond any of them is REFUSED with
 * the limit named, never truncated: a partial table read as if it were whole would be a silent wrong answer.
 */
export const TABULAR_LIMITS = {
  /** Cells holding a value, across the whole workbook or file. */
  maxCells: 1_000_000,
  /** Excel's own column limit (XFD). */
  maxColumns: 16_384,
  /** Excel's own row limit. */
  maxRows: 1_048_576,
  /** Excel's own per-cell text limit. */
  maxCellChars: 32_767,
  maxSheets: 255,
  /** Rows scanned from the top of a table for its header. */
  headerScanRows: 25,
} as const;

export type TabularLimits = { -readonly [K in keyof typeof TABULAR_LIMITS]: number };

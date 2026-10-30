/**
 * What each taxonomy case SHOULD achieve from the free text-layer tier. A case that does not yet meet its target carries
 * `knownGap`: the suite then asserts it STILL fails (strict xfail), so a fix cannot land without removing the marker, and
 * a regression cannot hide behind one. Targets are set from the failure class, not from what the code currently does.
 */
export interface Target {
  /** The document must open (some page text comes back). Default true unless `refusedWith` is set. */
  readonly opened?: boolean;
  readonly minWordF1?: number;
  readonly minSequence?: number;
  /** Every page must be flagged for recovery (no usable text layer) rather than returned as text. */
  readonly allPagesFlagged?: boolean;
  /** The document must be refused with exactly this error code (and yield no text). */
  readonly refusedWith?: string;
  /** Minimum count of pages that must come back with text. */
  readonly minPagesWithText?: number;
  /** Maximum pages that may be left unaccounted. */
  readonly maxUnaccounted?: number;
  /** Wall-clock ceiling for the free tier in ms. */
  readonly maxMs?: number;
  /** This target is not yet met; the suite asserts the miss. Remove when fixed. */
  readonly knownGap?: string;
}

const READ: Target = { minWordF1: 0.95, minSequence: 0.95, maxMs: 5000 };

export const TARGETS: Readonly<Record<string, Target>> = {
  'control-text-3p': READ,
  'layout-page-rotate-90': READ,
  'layout-page-rotate-180': READ,
  'layout-page-rotate-270': READ,
  'layout-text-rotated-90': READ,
  'layout-text-rotated-270': READ,
  'layout-text-skewed-3deg': READ,
  'layout-text-skewed-minus-4deg': READ,
  'layout-2-column': {
    minWordF1: 0.95,
    minSequence: 0.9,
    knownGap: 'columns are merged into one line per y; reading order interleaves them',
  },
  'layout-3-column': {
    minWordF1: 0.95,
    minSequence: 0.9,
    knownGap: 'columns are merged into one line per y; reading order interleaves them and words are lost',
  },
  'table-plain': READ,
  'table-wrapped': { minWordF1: 0.95, minSequence: 0.75, maxMs: 5000 },
  'table-merged': READ,
  'form-acroform-text-fields': { minWordF1: 0.95, knownGap: 'AcroForm field values (/V and appearance streams) are not read' },
  'script-cyrillic-tounicode': READ,
  'script-greek-tounicode': READ,
  'script-arabic-tounicode': READ,
  'script-cjk-tounicode': READ,
  'script-latin-extended-tounicode': READ,
  'font-subset-no-tounicode': { allPagesFlagged: true },
  'font-type3-glyph-names': READ,
  'font-ligatures': { minWordF1: 0.95 },
  'font-vector-outlined-text': { allPagesFlagged: true },
  'enc-owner-only-rc4-128': { minWordF1: 0.95, knownGap: 'decryption is not implemented' },
  'enc-owner-only-aes-128': { minWordF1: 0.95, knownGap: 'decryption is not implemented' },
  'enc-owner-only-rc4-40': { minWordF1: 0.95, knownGap: 'decryption is not implemented' },
  'enc-user-password-rc4-128': { refusedWith: 'XO_PDF_ENCRYPTED' },
  'enc-user-password-aes-128': { refusedWith: 'XO_PDF_ENCRYPTED' },
  'scale-3000-pages': { minPagesWithText: 3000, maxMs: 10_000 },
  'scale-huge-single-page': { minPagesWithText: 1, maxMs: 10_000 },
  'corrupt-bad-xref-offsets': { minWordF1: 0.95, knownGap: 'bad xref offsets fail the document instead of triggering the rebuild scan' },
  'corrupt-no-xref': READ,
  'corrupt-garbage-prefix': READ,
  'corrupt-truncated-90': { minPagesWithText: 1, maxMs: 5000 },
  'corrupt-bad-length': READ,
  'corrupt-flate-error-page2': { minPagesWithText: 2, maxUnaccounted: 1, minWordF1: 0.6, maxMs: 5000 },
  'corrupt-unsupported-filter-page2': { minPagesWithText: 2, maxUnaccounted: 1, minWordF1: 0.6, maxMs: 5000 },
  'corrupt-random-bytes': { opened: false, maxMs: 2000 },
  'corrupt-empty': { opened: false, maxMs: 2000 },
  'inert-javascript-openaction': READ,
  'inert-embedded-file': READ,
  'bomb-flate-300mb': { minPagesWithText: 1, maxUnaccounted: 1, maxMs: 5000 },
  'bomb-runlength': {
    minPagesWithText: 1,
    maxUnaccounted: 1,
    maxMs: 1000,
    knownGap: 'RunLengthDecode builds the output with number[] pushes (about 2 s for 80 MiB)',
  },
  'bomb-many-streams': { maxMs: 8000 },
};

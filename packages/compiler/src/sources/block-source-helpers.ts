import { buildSections } from '../document/section-builder.js';
import type { DocumentBlock, ParsedDocument, Provenance } from '../document/types.js';

/**
 * `document/types.ts#Provenance` is `{ page, yRange }` — genuinely PDF
 * shaped (PDF user-space y-coordinates, "top (higher y) first"). Stage
 * 8 §21 forbids redesigning that type, so non-PDF frontends reuse it by
 * assigning a synthetic, honestly-documented ordering rather than real
 * coordinates: `page` carries whatever unit of "location" is natural
 * for the source (always `1` for a single HTML document; the 1-based
 * record index for structured data, so `page` reads the same way "PDF
 * page 7" does — see Stage 8 §12's example list), and `yRange` is a
 * strictly-descending counter over the flat block stream so block order
 * is still recoverable from provenance alone, matching the PDF
 * convention's ordering semantics without claiming real spatial
 * coordinates. This is never presented as a real page/coordinate to a
 * caller inspecting `CanonicalSource.metadata` — see each frontend's own
 * `metadata.locationHint`-style fields for the truthful, source-specific
 * location string.
 */
export function syntheticProvenance(page: number, indexFromTop: number, totalBlocksOnPage: number): Provenance {
  const top = totalBlocksOnPage - indexFromTop;
  return { page, yRange: [top, top - 1] };
}

/** `ParsedDocument.bodyFontSizePt` has no meaning outside a PDF-sourced document (there is no font to measure) — every non-PDF frontend uses this fixed nominal value and documents it as such in its own module, rather than inventing a number that would look like a real measurement. */
export const NOMINAL_BODY_FONT_SIZE_PT = 12;

/** Nests a flat, already-classified `DocumentBlock[]` into a `ParsedDocument`, reusing the exact same `buildSections` Stage 2 uses for PDF-sourced content (Stage 8 §15: "the core pipeline should not contain source-specific branches" — this is the corollary for the frontend side, not duplicating the one piece of Stage 2 that *is* source-agnostic). */
export function parsedDocumentFromBlocks(blocks: readonly DocumentBlock[]): ParsedDocument {
  return { root: buildSections(blocks), bodyFontSizePt: NOMINAL_BODY_FONT_SIZE_PT };
}

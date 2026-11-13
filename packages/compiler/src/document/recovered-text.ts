import type { LoadedPdfPage } from '../pdf/pdf-loader.js';
import type { DocumentSection, ParsedDocument, Provenance } from './types.js';

/**
 * UW-3: every block from a page whose text was recovered (rather than read from its own text layer) says so in its provenance, with the
 * tier and confidence the coverage ledger records for that page.
 */
export function markRecoveredText(parsed: ParsedDocument, pages: readonly LoadedPdfPage[]): ParsedDocument {
  const byPage = new Map<number, NonNullable<Provenance['textSource']>>();
  for (const p of pages) {
    if (p.recovery === undefined) continue;
    byPage.set(p.pageNumber, {
      kind: 'recovered',
      tier: p.recovery.tier,
      confidence: p.recovery.confidence,
      ...(p.recovery.costClass !== undefined ? { costClass: p.recovery.costClass } : {}),
    });
  }
  if (byPage.size === 0) return parsed;
  const mark = <B extends { readonly provenance: Provenance }>(b: B): B => {
    const textSource = byPage.get(b.provenance.page);
    return textSource === undefined ? b : { ...b, provenance: { ...b.provenance, textSource } };
  };
  const walk = (section: DocumentSection): DocumentSection => ({
    heading: section.heading === undefined ? undefined : mark(section.heading),
    blocks: section.blocks.map(mark),
    subsections: section.subsections.map(walk),
  });
  return { ...parsed, root: walk(parsed.root) };
}

import type { DocumentSection, ParsedDocument } from '../document/types.js';

/**
 * A table found in the source: consecutive `table_row` blocks. The first row is the header when it has no numbers in a
 * column whose later rows do (the usual shape of a rate or schedule table).
 */
export interface PolicyTable {
  /** nearest preceding heading or paragraph, as the table's caption */
  readonly caption: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface PolicyDocumentText {
  /** markdown the policy segmenter reads: headings, paragraphs and list items; table rows are NOT in it */
  readonly text: string;
  readonly tables: readonly PolicyTable[];
}

const isNumeric = (s: string): boolean => /^[-+]?\$?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|[a-zA-Z/]{0,6})?$/.test(s.trim());

/** Renders a parsed document back to the markdown the policy stage reads, pulling tables out as structured rows. */
export function policyTextFromParsed(parsed: ParsedDocument, title?: string): PolicyDocumentText {
  const out: string[] = [];
  const tables: PolicyTable[] = [];
  let caption = '';
  let pending: string[][] = [];

  const flushTable = (): void => {
    if (pending.length < 2) {
      // a lone "row" is not a table: keep it as text so no sentence is lost
      for (const r of pending) out.push(r.join(' '), '');
      pending = [];
      return;
    }
    const [first, ...rest] = pending as [string[], ...string[][]];
    const headerLooksLikeHeader = first.some((c) => !isNumeric(c)) && rest.some((r) => r.some(isNumeric));
    tables.push(headerLooksLikeHeader ? { caption, header: first, rows: rest } : { caption, header: [], rows: pending });
    pending = [];
  };

  const walk = (section: DocumentSection, depth: number): void => {
    if (section.heading !== undefined) {
      flushTable();
      caption = section.heading.text;
      out.push(`${'#'.repeat(Math.min(6, Math.max(1, depth)))} ${section.heading.text}`, '');
    }
    for (const b of section.blocks) {
      if (b.kind === 'table_row') {
        pending.push([...b.cells]);
        continue;
      }
      flushTable();
      if (b.kind === 'heading') {
        caption = b.text;
        out.push(`${'#'.repeat(Math.min(6, Math.max(1, b.level)))} ${b.text}`, '');
      } else if (b.kind === 'list_item') out.push(`- ${b.text}`, '');
      else {
        out.push(b.text, '');
        caption = b.text.slice(0, 80);
      }
    }
    flushTable();
    for (const sub of section.subsections) walk(sub, depth + 1);
  };
  walk(parsed.root, 0);
  const body = out.join('\n').trim();
  return { text: title !== undefined && !/^#\s/.test(body) ? `# ${title}\n\n${body}` : body, tables };
}

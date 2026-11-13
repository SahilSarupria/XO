// Builds small .xlsx workbooks for tests, cell by cell, with the parts a real workbook has (styles, shared strings, merges, hidden sheets).
import { zip } from '../sources/zip-builder.js';

export type TestCell =
  | { readonly s: string } // shared string
  | { readonly is: string } // inline string
  | { readonly n: number | string; readonly style?: number; readonly f?: string } // number (optionally formatted, optionally a formula)
  | { readonly b: boolean }
  | { readonly e: string }
  | { readonly str: string; readonly f: string }; // formula with a string result

export interface TestSheet {
  readonly name: string;
  /** row number -> cells by column letter */
  readonly rows: Readonly<Record<number, Readonly<Record<string, TestCell>>>>;
  readonly merges?: readonly string[];
  readonly hidden?: boolean;
}

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Styles: index 0 General, 1 built-in date (14), 2 custom `dd/mm/yyyy` (164), 3 custom `0.00%` (165, not a date),
 * 4 custom `[$-409]d-mmm-yy;@` (166, a date with a locale prefix), 5 built-in time (21).
 */
const STYLES = `<styleSheet ${NS}><numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="[$-409]d-mmm-yy;@"/></numFmts><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="21"/></cellXfs></styleSheet>`;

export function workbook(
  sheets: readonly TestSheet[],
  options: { readonly date1904?: boolean; readonly extraParts?: { name: string; data: string }[] } = {},
): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = (t: string) => {
    const i = shared.indexOf(t);
    if (i >= 0) return i;
    shared.push(t);
    return shared.length - 1;
  };
  const sheetXml = sheets.map((sh) => {
    const rows = Object.entries(sh.rows)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([r, cells]) => {
        const cs = Object.entries(cells).map(([col, c]) => {
          const ref = `${col}${r}`;
          if ('s' in c) return `<c r="${ref}" t="s"><v>${sharedIndex(c.s)}</v></c>`;
          if ('is' in c) return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.is)}</t></is></c>`;
          if ('b' in c) return `<c r="${ref}" t="b"><v>${c.b ? 1 : 0}</v></c>`;
          if ('e' in c) return `<c r="${ref}" t="e"><v>${esc(c.e)}</v></c>`;
          if ('str' in c) return `<c r="${ref}" t="str"><f>${esc(c.f)}</f><v>${esc(c.str)}</v></c>`;
          return `<c r="${ref}"${c.style !== undefined ? ` s="${c.style}"` : ''}>${c.f !== undefined ? `<f>${esc(c.f)}</f>` : ''}<v>${c.n}</v></c>`;
        });
        return `<row r="${r}">${cs.join('')}</row>`;
      });
    const merges =
      sh.merges !== undefined && sh.merges.length > 0
        ? `<mergeCells>${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
        : '';
    return `<worksheet ${NS}><sheetData>${rows.join('')}</sheetData>${merges}</worksheet>`;
  });
  const wb = `<workbook ${NS}>${options.date1904 === true ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets
    .map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}"${sh.hidden === true ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="x/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;
  const sst = `<sst ${NS}>${shared.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`;
  return zip([
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/sharedStrings.xml', data: sst },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    ...(options.extraParts ?? []),
  ]);
}

/** A row of shared strings. */
export const texts = (cols: string, ...values: string[]): Record<string, TestCell> =>
  Object.fromEntries(values.map((v, i) => [cols[i]!, { s: v }]));

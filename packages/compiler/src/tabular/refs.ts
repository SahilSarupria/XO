/** A1-reference helpers shared by the CSV and XLSX readers. */

export function columnLetter(column: number): string {
  let n = column;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `B7` -> { column: 2, row: 7 }; undefined for anything that is not a single A1 cell reference. */
export function parseA1(ref: string): { readonly column: number; readonly row: number } | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (m === null) return undefined;
  let column = 0;
  for (const ch of m[1]!.toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  return row >= 1 ? { column, row } : undefined;
}

/** `Clients!B7`, quoting the sheet name the way spreadsheets do when it is not a plain identifier. */
export function cellRef(sheet: string | undefined, column: number, row: number): string {
  const a1 = `${columnLetter(column)}${row}`;
  if (sheet === undefined) return a1;
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? `${sheet}!${a1}` : `'${sheet.replace(/'/g, "''")}'!${a1}`;
}

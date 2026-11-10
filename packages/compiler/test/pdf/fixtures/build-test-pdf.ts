import { deflateSync } from 'node:zlib';

export interface TestPageSpec {
  /** Content-stream operators as a raw string — the fixture builder wraps this in `BT ... ET` if it doesn't already contain one, and FlateDecode-compresses it, exactly like a real PDF writer would. */
  readonly contentOps: string;
  readonly mediaBox?: readonly [number, number, number, number];
  /** Adds a page-sized image XObject to the page's resources, like a scanned page. */
  readonly image?: boolean;
  /** If set, written verbatim as the content stream (no `BT ... ET` wrapping), so a test can build a genuinely empty page with `''`. */
  readonly rawContent?: string;
  /** If set, the content stream declares this `/Filter` name but holds plain bytes — an unsupported filter (e.g. `LZWDecode`) makes just this page fail to load. */
  readonly contentFilter?: string;
}

export interface TestPdfSpec {
  readonly pages: readonly TestPageSpec[];
  readonly title?: string;
  readonly author?: string;
  /** If true, the fixture is written with a deliberately wrong /Length on page 1's content stream, to exercise the endstream-scanning recovery path. */
  readonly corruptLength?: boolean;
}

/**
 * Builds a minimal-but-real, spec-conformant PDF byte buffer for tests —
 * classic (non-cross-reference-stream) xref table, FlateDecode content
 * streams (via the same built-in `zlib` the loader itself uses to
 * inflate), a proper page tree, and an `/Info` dictionary. This exists so
 * `pdf-loader.test.ts` exercises the parser against real, valid PDF
 * bytes end-to-end rather than hand-mocking intermediate parser output —
 * the "golden test" fixtures this package's tests use are generated here
 * rather than checked in as binary files, since no real-world sample
 * legal PDFs were available in the environment this was built in (see
 * this package's README).
 */
export function buildTestPdf(spec: TestPdfSpec): Uint8Array {
  const chunks: Buffer[] = [];
  let offset = 0;
  const objectOffsets: number[] = [0]; // index 0 unused (object numbers are 1-based)

  const push = (text: string): void => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };
  const pushBytes = (buf: Buffer): void => {
    chunks.push(buf);
    offset += buf.length;
  };
  const beginObject = (objectNumber: number): void => {
    objectOffsets[objectNumber] = offset;
    push(`${objectNumber} 0 obj\n`);
  };
  const endObject = (): void => {
    push('endobj\n');
  };

  push('%PDF-1.7\n');

  const pageCount = spec.pages.length;
  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Info, then for each page i (0-based): (4 + i*2) = Page, (4 + i*2 + 1) = Content stream.
  const pagesObjNum = 2;
  const infoObjNum = 3;
  const firstPageObjNum = 4;

  const fontObjNumEarly = firstPageObjNum + pageCount * 2;
  const imageObjNumByPage = new Map<number, number>();
  spec.pages.forEach((page, i) => {
    if (page.image === true) imageObjNumByPage.set(i, fontObjNumEarly + 1 + imageObjNumByPage.size);
  });

  beginObject(1);
  push(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>\n`);
  endObject();

  const kidsRefs = Array.from({ length: pageCount }, (_, i) => `${firstPageObjNum + i * 2} 0 R`).join(' ');
  beginObject(pagesObjNum);
  push(
    `<< /Type /Pages /Kids [${kidsRefs}] /Count ${pageCount} /Resources << /Font << /F1 ${firstPageObjNum + pageCount * 2} 0 R >> >> /MediaBox [0 0 612 792] >>\n`,
  );
  endObject();

  beginObject(infoObjNum);
  const infoParts: string[] = [];
  if (spec.title !== undefined) infoParts.push(`/Title (${escapePdfLiteral(spec.title)})`);
  if (spec.author !== undefined) infoParts.push(`/Author (${escapePdfLiteral(spec.author)})`);
  push(`<< ${infoParts.join(' ')} >>\n`);
  endObject();

  spec.pages.forEach((page, i) => {
    const pageObjNum = firstPageObjNum + i * 2;
    const contentObjNum = pageObjNum + 1;
    const mediaBoxStr = page.mediaBox ? `[${page.mediaBox.join(' ')}]` : undefined;

    beginObject(pageObjNum);
    const imageObjNum = imageObjNumByPage.get(i);
    const resourcesStr =
      imageObjNum !== undefined ? ` /Resources << /Font << /F1 ${fontObjNumEarly} 0 R >> /XObject << /Im1 ${imageObjNum} 0 R >> >>` : '';
    push(
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /Contents ${contentObjNum} 0 R${mediaBoxStr ? ` /MediaBox ${mediaBoxStr}` : ''}${resourcesStr} >>\n`,
    );
    endObject();

    const rawOps =
      page.rawContent !== undefined ? page.rawContent : page.contentOps.includes('BT') ? page.contentOps : `BT ${page.contentOps} ET`;
    const unsupportedFilter = page.contentFilter;
    const compressed = unsupportedFilter !== undefined ? Buffer.from(rawOps, 'latin1') : deflateSync(Buffer.from(rawOps, 'latin1'));
    const declaredLength = spec.corruptLength && i === 0 ? compressed.length + 1000 : compressed.length;

    beginObject(contentObjNum);
    push(`<< /Length ${declaredLength} /Filter /${unsupportedFilter ?? 'FlateDecode'} >>\nstream\n`);
    pushBytes(compressed);
    push('\nendstream\n');
    endObject();
  });

  const fontObjNum = firstPageObjNum + pageCount * 2;
  beginObject(fontObjNum);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n');
  endObject();

  for (const [, imageObjNum] of imageObjNumByPage) {
    beginObject(imageObjNum);
    push('<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /BitsPerComponent 1 /ColorSpace /DeviceGray /Length 4 >>\nstream\n');
    push('\0\0\0\0');
    push('\nendstream\n');
    endObject();
  }

  const xrefOffset = offset;
  const totalObjects = fontObjNum + 1 + imageObjNumByPage.size;
  push(`xref\n0 ${totalObjects}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i < totalObjects; i += 1) {
    push(`${String(objectOffsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjects} /Root 1 0 R /Info ${infoObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Uint8Array(Buffer.concat(chunks));
}

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

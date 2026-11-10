import { createHash } from 'node:crypto';
import { needsEngineHelp } from '../router.js';
import type { PageRecovery, PageTier } from '../types.js';
import type { GrayImage } from './png.js';

/**
 * pdfium (via the MIT-licensed `@hyzyla/pdfium` WASM build) as an OPTIONAL second reader and page rasteriser.
 * The package is an `optionalDependency`: when it is not installed, `loadPdfium()` returns `undefined` and every tier
 * built on it reports itself unavailable, so the default free path is unaffected. pdfium's WASM instance is
 * single-threaded, so all calls are serialised through one queue.
 */
interface PdfiumPage {
  getText(): string;
  render(opts: {
    scale?: number;
    width?: number;
    height?: number;
    colorSpace?: 'Gray' | 'RGBA';
  }): Promise<{ width: number; height: number; data: Uint8Array }>;
  getOriginalSize(): { originalWidth: number; originalHeight: number };
  close(): void;
}
interface PdfiumDocument {
  getPageCount(): number;
  getPage(i: number): PdfiumPage;
  destroy(): void;
}
interface PdfiumLibrary {
  loadDocument(bytes: Uint8Array, password?: string): Promise<PdfiumDocument>;
  destroy(): void;
}

let libraryPromise: Promise<PdfiumLibrary | undefined> | undefined;
let queue: Promise<unknown> = Promise.resolve();

export function loadPdfium(): Promise<PdfiumLibrary | undefined> {
  libraryPromise ??= (async () => {
    try {
      const name = '@hyzyla/pdfium';
      const mod = (await import(name)) as { PDFiumLibrary: { init(): Promise<PdfiumLibrary> } };
      return await mod.PDFiumLibrary.init();
    } catch {
      return undefined;
    }
  })();
  return libraryPromise;
}

export async function isPdfiumAvailable(): Promise<boolean> {
  return (await loadPdfium()) !== undefined;
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** A small LRU of open documents keyed by the exact byte array, so one document is parsed once however many of its pages are recovered. */
const open = new Map<Uint8Array, Promise<PdfiumDocument | undefined>>();
const MAX_OPEN = 2;

function documentFor(bytes: Uint8Array): Promise<PdfiumDocument | undefined> {
  let p = open.get(bytes);
  if (p === undefined) {
    p = (async () => {
      const lib = await loadPdfium();
      if (lib === undefined) return undefined;
      try {
        return await serial(() => lib.loadDocument(bytes));
      } catch {
        return undefined;
      }
    })();
    open.set(bytes, p);
    while (open.size > MAX_OPEN) {
      const [oldKey, oldDoc] = open.entries().next().value as [Uint8Array, Promise<PdfiumDocument | undefined>];
      open.delete(oldKey);
      void oldDoc.then((d) => d && serial(async () => d.destroy()));
    }
  }
  return p;
}

export async function shutdownPdfium(): Promise<void> {
  for (const p of open.values()) await p.then((d) => d && serial(async () => d.destroy())).catch(() => undefined);
  open.clear();
  const lib = await libraryPromise;
  libraryPromise = undefined;
  lib?.destroy();
}

export interface RenderOptions {
  /** Target resolution. Default 200 (good for OCR). */
  readonly dpi?: number;
  /** Hard cap on pixels, so a huge page can never allocate an enormous bitmap. Default 16 million. */
  readonly maxPixels?: number;
  /** Cap on the longest edge in pixels (used before sending an image to a model). */
  readonly maxLongEdge?: number;
}

/** Renders one page (1-based) to an 8-bit grayscale bitmap, or `undefined` if pdfium is unavailable or cannot open the page. */
export async function renderPageGray(
  bytes: Uint8Array,
  pageNumber: number,
  opts: RenderOptions = {},
): Promise<(GrayImage & { readonly scale: number }) | undefined> {
  const doc = await documentFor(bytes);
  if (doc === undefined) return undefined;
  return serial(async () => {
    if (pageNumber < 1 || pageNumber > doc.getPageCount()) return undefined;
    const page = doc.getPage(pageNumber - 1);
    try {
      const { originalWidth, originalHeight } = page.getOriginalSize();
      let scale = (opts.dpi ?? 200) / 72;
      const maxPixels = opts.maxPixels ?? 16_000_000;
      scale = Math.min(scale, Math.sqrt(maxPixels / Math.max(1, originalWidth * originalHeight)));
      if (opts.maxLongEdge !== undefined) scale = Math.min(scale, opts.maxLongEdge / Math.max(originalWidth, originalHeight, 1));
      const r = await page.render({ scale: Math.max(scale, 0.05), colorSpace: 'Gray' });
      return { width: r.width, height: r.height, data: r.data, scale: r.width / Math.max(originalWidth, 1) };
    } finally {
      page.close();
    }
  });
}

/** How plausible a block of recovered text is as language: share of letters/digits/space/punctuation, none replacement characters. 0..1. */
export function textPlausibility(text: string): number {
  let good = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    total += 1;
    if (ch === '\uFFFD') continue;
    if (/[\p{L}\p{N}\p{P}\p{Sc}]/u.test(ch)) good += 1;
  }
  return total === 0 ? 0 : good / total;
}

export interface PdfiumReaderOptions {
  /** Minimum non-space characters for pdfium's text to count as a recovery. Default 8. */
  readonly minChars?: number;
}

/**
 * Tier `free`: reads the page's text layer with a SECOND engine. It rescues pages where the own reader fails on a font,
 * filter or structure that pdfium handles. It cannot read scans: pdfium returns no text for them, and the tier then
 * reports nothing so the router moves on to OCR.
 */
export function createPdfiumReaderTier(options: PdfiumReaderOptions = {}): PageTier {
  const minChars = options.minChars ?? 8;
  return {
    name: 'pdfium-text',
    version: '1',
    costClass: 'free',
    handles: needsEngineHelp,
    async recover({ page, bytes, signal }): Promise<PageRecovery | undefined> {
      const doc = await documentFor(bytes);
      if (doc === undefined || signal?.aborted === true) return undefined;
      const text = await serial(async () => {
        if (page.pageNumber > doc.getPageCount()) return '';
        const p = doc.getPage(page.pageNumber - 1);
        try {
          return p.getText();
        } finally {
          p.close();
        }
      });
      const lines = text
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.join('').replace(/\s/gu, '').length < minChars) return undefined;
      const [, , , top] = page.mediaBox;
      return {
        // pdfium's plain text carries order but no coordinates: lines are laid out top to bottom in that order.
        lines: lines.map((t, i) => ({ text: t, x: 72, y: top - 72 - i * 14, fontSizePt: 11 })),
        confidence: Number((0.95 * textPlausibility(text)).toFixed(3)),
      };
    },
  };
}

export const bytesKey = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

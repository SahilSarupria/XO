import { createRequire } from 'node:module';
import { needsEngineHelp } from '../router.js';
import type { PageRecovery, PageTier, RecoveredLine } from '../types.js';
import { cropToContent, encodeGrayPng, rotateGray, type GrayImage } from './png.js';
import { renderPageGray } from './pdfium.js';

/**
 * Local OCR with tesseract.js (Apache-2.0, WASM) over pages rasterised by pdfium. Fully offline: the English
 * traineddata comes from the `@tesseract.js-data/eng` package, so nothing is fetched at runtime. Both packages are
 * `optionalDependencies`; without them the tier reports itself unavailable and the default path is unchanged.
 */
interface TessWord {
  readonly confidence: number;
}
interface TessLine {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly words?: readonly TessWord[];
}
interface TessBlock {
  readonly paragraphs?: readonly { readonly lines?: readonly TessLine[] }[];
}
interface TessWorker {
  recognize(
    image: Buffer,
    options: Record<string, unknown>,
    output: Record<string, boolean>,
  ): Promise<{ data: { text: string; confidence: number; blocks?: readonly TessBlock[] | null } }>;
  terminate(): Promise<unknown>;
}

export interface TesseractOptions {
  /** Directory with `<lang>.traineddata[.gz]`. Default: the `@tesseract.js-data/eng` package. */
  readonly langPath?: string;
  readonly lang?: string;
  /** Workers (each a separate WASM instance). Default 2. */
  readonly workers?: number;
  /** OCR resolution. Default 200 dpi. */
  readonly dpi?: number;
  /** A first pass below this mean confidence (0..1) triggers trying the other three orientations. Default 0.6. */
  readonly rotationRetryBelow?: number;
  /** Hard limit for OCR of one page across all orientation attempts; a hung recognition is terminated. Default 20_000 ms. */
  readonly maxMsPerPage?: number;
}

let engineVersion: string | undefined;
function tesseractVersion(): string {
  if (engineVersion === undefined) {
    try {
      engineVersion = (createRequire(import.meta.url)('tesseract.js/package.json') as { version: string }).version;
    } catch {
      engineVersion = 'unavailable';
    }
  }
  return engineVersion;
}

function defaultLangPath(): string | undefined {
  try {
    const data = createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string };
    return data.langPath;
  } catch {
    return undefined;
  }
}

export async function isTesseractAvailable(): Promise<boolean> {
  try {
    const name = 'tesseract.js';
    await import(name);
    return defaultLangPath() !== undefined;
  } catch {
    return false;
  }
}

class WorkerPool {
  private readonly idle: TessWorker[] = [];
  private readonly waiters: { resolve: (w: TessWorker) => void; reject: (e: unknown) => void }[] = [];
  private created = 0;
  private all: TessWorker[] = [];
  constructor(
    private readonly size: number,
    private readonly make: () => Promise<TessWorker>,
  ) {}
  private async spawn(): Promise<TessWorker> {
    this.created += 1;
    try {
      const nw = await this.make();
      this.all.push(nw);
      return nw;
    } catch (e) {
      this.created -= 1;
      throw e;
    }
  }
  async acquire(): Promise<TessWorker> {
    const w = this.idle.pop();
    if (w !== undefined) return w;
    if (this.created < this.size) return this.spawn();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  release(w: TessWorker): void {
    const next = this.waiters.shift();
    if (next !== undefined) next.resolve(w);
    else this.idle.push(w);
  }
  /** Terminates a worker that is stuck in a recognition (aborted/timed out) and replaces it if anyone is waiting. */
  async discard(w: TessWorker): Promise<void> {
    this.all = this.all.filter((x) => x !== w);
    this.created -= 1;
    void w.terminate().catch(() => undefined);
    const next = this.waiters.shift();
    if (next !== undefined) this.spawn().then(next.resolve, next.reject);
  }
  async shutdown(): Promise<void> {
    const all = this.all;
    this.all = [];
    this.idle.length = 0;
    this.created = 0;
    await Promise.all(all.map((w) => w.terminate().catch(() => undefined)));
  }
}

const pools = new Map<string, WorkerPool>();

function poolFor(options: TesseractOptions): WorkerPool {
  const lang = options.lang ?? 'eng';
  const langPath = options.langPath ?? defaultLangPath() ?? '';
  const key = `${lang}|${langPath}|${options.workers ?? 2}`;
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = new WorkerPool(options.workers ?? 2, async () => {
      const name = 'tesseract.js';
      const t = (await import(name)) as { createWorker(lang: string, oem: number, opts: Record<string, unknown>): Promise<TessWorker> };
      return t.createWorker(lang, 1, { langPath, gzip: true, cacheMethod: 'none' });
    });
    pools.set(key, pool);
  }
  return pool;
}

export async function shutdownTesseract(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.shutdown()));
  pools.clear();
}

class OcrAborted extends Error {}

async function ocr(
  pool: WorkerPool,
  img: GrayImage,
  signal: AbortSignal | undefined,
): Promise<{ lines: readonly TessLine[]; confidence: number; text: string }> {
  if (signal?.aborted === true) throw new OcrAborted();
  const w = await pool.acquire();
  let discarded = false;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      discarded = true;
      void pool.discard(w);
      reject(new OcrAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    // tesseract.js only returns the block/paragraph/line tree when asked for it.
    const work = w.recognize(encodeGrayPng(img.width, img.height, img.data), {}, { blocks: true });
    work.catch(() => undefined);
    const r = await Promise.race([work, aborted]);
    const lines = (r.data.blocks ?? []).flatMap((b) => (b.paragraphs ?? []).flatMap((p) => p.lines ?? []));
    return { lines, confidence: r.data.confidence / 100, text: r.data.text };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!discarded) pool.release(w);
  }
}

/** Tier `local`: OCR on this machine. Time, no tokens, no network. */
export function createTesseractTier(options: TesseractOptions = {}): PageTier {
  const dpi = options.dpi ?? 200;
  const retryBelow = options.rotationRetryBelow ?? 0.6;
  const lang = options.lang ?? 'eng';
  return {
    name: 'tesseract-ocr',
    // Output depends on the engine, language data and settings; bump any of them and old cache entries stop matching.
    version: `1|${tesseractVersion()}|${lang}|${dpi}`,
    costClass: 'local',
    handles: needsEngineHelp,
    async recover({ page, bytes, signal: outer }): Promise<PageRecovery | undefined> {
      const limit = AbortSignal.timeout(options.maxMsPerPage ?? 20_000);
      const signal = outer === undefined ? limit : AbortSignal.any([outer, limit]);
      const aborted = (): boolean => signal?.aborted === true;
      if (aborted() || !(await isTesseractAvailable())) return undefined;
      const rendered = await renderPageGray(bytes, page.pageNumber, { dpi });
      if (rendered === undefined) return undefined;
      const pool = poolFor(options);
      const content = cropToContent(rendered);
      let best: { lines: readonly TessLine[]; confidence: number; text: string; rotation: number } | undefined;
      for (const rotation of [0, 90, 180, 270] as const) {
        if (aborted()) return undefined;
        let res: Awaited<ReturnType<typeof ocr>>;
        try {
          res = await ocr(pool, rotateGray(content, rotation), signal);
        } catch (e) {
          if (e instanceof OcrAborted) return undefined;
          throw e;
        }
        if (best === undefined || res.confidence > best.confidence) best = { ...res, rotation };
        if (best.confidence >= retryBelow) break;
      }
      if (best === undefined || best.text.trim().length === 0) return undefined;
      // Line positions are used for reading order only: they are relative to the cropped, possibly rotated OCR image
      // and mapped top-to-bottom into the page's point space.
      const pt = (v: number): number => v / rendered.scale;
      const [, , , top] = page.mediaBox;
      const out: RecoveredLine[] = best.lines
        .filter((l) => l.text.trim().length > 0)
        .map((l) => ({
          text: l.text.trim(),
          x: pt(l.bbox.x0),
          y: top - pt(l.bbox.y1),
          fontSizePt: Math.max(6, pt(l.bbox.y1 - l.bbox.y0) * 0.8),
        }));
      if (out.length === 0) return undefined;
      return { lines: out, confidence: Number(Math.max(0, Math.min(1, best.confidence)).toFixed(3)) };
    },
  };
}

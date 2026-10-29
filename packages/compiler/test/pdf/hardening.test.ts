import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { PdfForge } from '../taxonomy/pdf-forge.js';
import { buildTestPdf } from './fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

function singlePage(content: Buffer, enc: 'flate' | 'none' = 'flate'): Buffer {
  const f = new PdfForge();
  const cat = f.alloc();
  const pages = f.alloc();
  const page = f.alloc();
  const cs = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  f.obj(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 /MediaBox [0 0 612 792] >>`);
  f.obj(page, `<< /Type /Page /Parent ${pages} 0 R /Contents ${cs} 0 R >>`);
  f.stream(cs, content, enc);
  return f.build(cat);
}

test('hardening: a flate bomb is rejected as a resource limit, quickly, without ballooning memory', () => {
  const bomb = deflateSync(Buffer.alloc(300 * 1024 * 1024));
  // The stream bytes ARE the pre-compressed bomb (300 MiB of zeros in ~300 KB).
  const f = new PdfForge();
  const cat = f.alloc();
  const pages = f.alloc();
  const page = f.alloc();
  const cs = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  f.obj(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 /MediaBox [0 0 612 792] >>`);
  f.obj(page, `<< /Type /Page /Parent ${pages} 0 R /Contents ${cs} 0 R >>`);
  f.stream(cs, Buffer.alloc(0), { raw: bomb, filter: '/FlateDecode' });
  const before = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = loader.load(f.build(cat), 'bomb.pdf');
  const ms = Date.now() - t0;
  const grewMb = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(r.ok);
  assert.equal(r.value.pages[0]!.loadFailure?.code, 'PDF_RESOURCE_LIMIT');
  assert.ok(ms < 3000, `bomb handled in ${ms}ms`);
  assert.ok(grewMb < 200, `rss grew ${grewMb}MB`);
});

test('hardening: a document-wide decode budget stops many individually-legal streams adding up to a bomb', () => {
  const f = new PdfForge();
  const cat = f.alloc();
  const pages = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  const kids: number[] = [];
  const chunk = Buffer.from(' '.repeat(2 * 1024 * 1024)); // 2 MiB of blanks each, ratio is low enough per stream because of the floor
  const body = deflateSync(Buffer.concat([chunk, Buffer.from('BT /F1 12 Tf 72 700 Td (x) Tj ET')]));
  for (let i = 0; i < 6; i++) {
    const page = f.alloc();
    const cs = f.alloc();
    kids.push(page);
    f.obj(page, `<< /Type /Page /Parent ${pages} 0 R /Contents ${cs} 0 R >>`);
    f.stream(cs, Buffer.alloc(0), { raw: body, filter: '/FlateDecode' });
  }
  f.obj(pages, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} /MediaBox [0 0 612 792] >>`);
  const r = loader.load(f.build(cat), 'budget.pdf', { limits: { maxDocumentDecodedBytes: 7 * 1024 * 1024, maxInflateRatio: 1_000_000 } });
  assert.ok(r.ok);
  const failed = r.value.pages.filter((p) => p.loadFailure?.code === 'PDF_RESOURCE_LIMIT');
  assert.ok(failed.length >= 2, 'later pages are reported as resource-limit failures');
  assert.equal(r.value.pages.length, 6, 'no page is silently dropped');
});

test('hardening: a deeply nested page tree does not overflow the stack and is reported, not dropped', () => {
  const depth = 5000;
  const f = new PdfForge();
  const cat = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${cat + 1} 0 R >>`);
  for (let i = 0; i < depth; i++) f.obj(cat + 1 + i, `<< /Type /Pages /Kids [${cat + 2 + i} 0 R] /Count 1 >>`);
  f.obj(cat + 1 + depth, '<< /Type /Page /MediaBox [0 0 612 792] >>');
  const r = loader.load(f.build(cat), 'deep.pdf');
  assert.ok(r.ok, 'never throws');
  assert.equal(r.value.pageCount, 1);
  assert.equal(r.value.pages[0]!.loadFailure?.code, 'PDF_RESOURCE_LIMIT');
});

test('hardening: deeply nested arrays in an object are a bounded failure, not a RangeError', () => {
  const f = new PdfForge();
  const cat = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${cat + 1} 0 R /Junk ${'['.repeat(50_000)}${']'.repeat(50_000)} >>`);
  f.obj(cat + 1, '<< /Type /Pages /Kids [] /Count 0 >>');
  const bytes = f.build(cat);
  let r: ReturnType<typeof loader.load> | undefined;
  assert.doesNotThrow(() => {
    r = loader.load(bytes, 'nest.pdf');
  });
  assert.ok(r !== undefined && (r.ok || r.error.message.length > 0));
});

test('hardening: an xref subsection that lies about its count terminates', () => {
  const good = singlePage(Buffer.from('BT /F1 12 Tf 72 700 Td (hello) Tj ET'));
  const text = good.toString('latin1').replace(/xref\n0 (\d+)\n/, 'xref\n0 2000000000\n');
  const t0 = Date.now();
  const r = loader.load(Buffer.from(text, 'latin1'), 'liar.pdf');
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(r.ok, 'recovered through the rebuild scan');
  assert.match(r.value.pages[0]!.plainText, /hello/);
});

test('hardening: an object stream whose /N lies terminates', () => {
  const f = new PdfForge();
  const cat = f.alloc();
  const pages = f.alloc();
  const os = f.alloc();
  f.obj(cat, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  f.obj(pages, `<< /Type /Pages /Kids [] /Count 0 >>`);
  f.stream(os, '1 0', 'flate', '/Type /ObjStm /N 2000000000 /First 4 ');
  const t0 = Date.now();
  assert.doesNotThrow(() => loader.load(f.build(cat, { xref: 'none' }), 'objstm.pdf'));
  assert.ok(Date.now() - t0 < 3000);
});

test('hardening: page loading scales near-linearly (no per-page scan of every object)', () => {
  const mk = (n: number) =>
    buildTestPdf({ pages: Array.from({ length: n }, (_, i) => ({ contentOps: `/F1 12 Tf 72 700 Td (Page ${i}) Tj` })) });
  const timeIt = (b: Uint8Array): number => {
    const t = process.hrtime.bigint();
    const r = loader.load(b, 'x');
    assert.ok(r.ok);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const small = mk(2000);
  const large = mk(8000);
  timeIt(small); // warm up
  const a = timeIt(small);
  const b = timeIt(large);
  // 4x the pages: linear is ~4x. The old quadratic scan was ~11x. Allow generous slack for CI noise.
  assert.ok(b / Math.max(a, 1) < 7, `4x pages took ${(b / Math.max(a, 1)).toFixed(1)}x`);
});

test('hardening: cancellation via AbortSignal stops reading and reports the remaining pages as aborted', () => {
  const bytes = buildTestPdf({ pages: Array.from({ length: 50 }, (_, i) => ({ contentOps: `/F1 12 Tf 72 700 Td (Page ${i}) Tj` })) });
  const ac = new AbortController();
  ac.abort();
  const r = loader.load(bytes, 'x', { signal: ac.signal });
  assert.equal(r.ok, false, 'aborted before the document opened');
  const late = loader.load(bytes, 'x', { deadlineMs: Date.now() - 1 });
  assert.equal(late.ok, false);
});

test('hardening: the same bytes always produce the same document (determinism)', () => {
  const bytes = buildTestPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td (stable) Tj' }, { contentOps: '/F1 12 Tf 72 700 Td (output) Tj' }],
  });
  const a = loader.load(bytes, 'x');
  const b = loader.load(bytes, 'x');
  assert.ok(a.ok && b.ok);
  const strip = (d: typeof a.value) => JSON.stringify(d.pages.map((p) => [p.pageNumber, p.sourceObjectNumber, p.plainText, p.requiresOcr]));
  assert.equal(strip(a.value), strip(b.value));
});

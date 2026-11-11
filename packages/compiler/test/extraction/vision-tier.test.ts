import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import {
  recoverUnreadPages,
  InMemoryRecoveryCache,
  createVisionTier,
  isPdfiumAvailable,
  shutdownPdfium,
} from '../../src/extraction/index.js';
import { computePdfCoverage } from '../../src/pdf/pdf-coverage.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { assessDocumentQuality } from '../../src/document/document-quality.js';

const available = await isPdfiumAvailable();
after(shutdownPdfium);
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../taxonomy/scan-fixtures/scan-clean-3p.pdf', import.meta.url))));
const load = () => {
  const r = new NodePdfLoader().load(bytes, 's.pdf');
  assert.ok(r.ok);
  return r.value;
};
const PRICED = { inputPerThousand: 0.001, outputPerThousand: 0.002 };

function fakeProvider(
  reply: (n: number) => Partial<ProviderResponse> & { text: string },
  vision = true,
): ModelProvider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    id: 'fake',
    requests,
    describeCapabilities: () => ({
      providerId: 'fake',
      models: ['m'],
      supportsStreaming: false,
      supportsStructuredOutput: true,
      supportsVision: vision,
      maxContextTokens: 100000,
    }),
    async complete(request) {
      requests.push(request);
      const r = reply(requests.length);
      return { usage: { inputTokens: 1500, outputTokens: 60 }, modelUsed: 'm', finishReason: 'stop', ...r };
    },
  };
}
const GOOD = (conf = 0.97) => ({
  text: JSON.stringify({
    legible: true,
    lines: ['Claim Assessment', 'If the claim assessment amount exceeds 10000, then deny the claim.'],
    confidence: conf,
  }),
});
const tierOf = (p: ModelProvider, extra: object = {}) =>
  createVisionTier({ provider: p, model: 'm', pricing: PRICED, acknowledgeDataLeavesMachine: true, ...extra });
const skip = available ? false : 'pdfium not installed';

test('vision: cannot be constructed without acknowledging that page images leave the machine', () => {
  assert.throws(
    () => createVisionTier({ provider: fakeProvider(() => GOOD()), model: 'm', pricing: PRICED } as never),
    /acknowledgeDataLeavesMachine/,
  );
});

test('vision: with the default budget the model is never called (zero spend)', { skip }, async () => {
  const p = fakeProvider(() => GOOD());
  const { ledger } = await recoverUnreadPages(load(), bytes, [tierOf(p)], { concurrency: 8 });
  assert.equal(p.requests.length, 0);
  assert.equal(ledger.totalCostUsd, 0);
  assert.equal(ledger.pagesRecovered, 0);
});

test('vision: a model with no known price can never be called, whatever the ceiling', { skip }, async () => {
  const p = fakeProvider(() => GOOD());
  const t = createVisionTier({ provider: p, model: 'unpriced-model', acknowledgeDataLeavesMachine: true });
  const { ledger } = await recoverUnreadPages(load(), bytes, [t], { maxCostUsd: 1000 });
  assert.equal(p.requests.length, 0);
  assert.ok(ledger.entries.every((e) => e.outcome === 'skipped_budget'));
});

test('vision: a provider without vision support is never offered a page', { skip }, async () => {
  const p = fakeProvider(() => GOOD(), false);
  await recoverUnreadPages(load(), bytes, [tierOf(p)], { maxCostUsd: 1 });
  assert.equal(p.requests.length, 0);
});

test(
  'vision: sends a cropped, size-capped PNG with a strict schema and temperature 0; spend is within the reservation',
  { skip },
  async () => {
    const p = fakeProvider(() => GOOD());
    const { ledger } = await recoverUnreadPages(load(), bytes, [tierOf(p, { maxLongEdge: 800 })], { maxCostUsd: 1 });
    assert.equal(p.requests.length, 3);
    const req = p.requests[0]!;
    assert.equal(req.temperature, 0);
    assert.equal((req.responseSchema as { additionalProperties?: boolean }).additionalProperties, false);
    const img = req.messages.find((m) => m.images !== undefined)!.images![0]!;
    const png = Buffer.from(img.dataBase64, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.ok(Math.max(w, h) <= 800, `image ${w}x${h} exceeds the cap`);
    assert.ok(ledger.totalCostUsd > 0 && ledger.totalCostUsd < 0.05);
    assert.equal(ledger.totalTokens, 3 * 1560);
  },
);

test('vision: confidence is capped at 0.9 and the source is never trusted while a page rests on model output', { skip }, async () => {
  const p = fakeProvider(() => GOOD(1));
  const { document } = await recoverUnreadPages(load(), bytes, [tierOf(p)], { maxCostUsd: 1 });
  assert.ok(document.pages.every((pg) => pg.recovery !== undefined && pg.recovery.confidence <= 0.9 && pg.recovery.costClass === 'model'));
  const cov = computePdfCoverage(document);
  assert.equal(cov.unaccountedPages, 0);
  const q = assessDocumentQuality(parseDocument(document), 's', cov);
  assert.equal(q.state, 'degraded');
  assert.ok(q.diagnostics.some((d) => d.code === 'source-quality/model-transcribed'));
});

test(
  'vision: malformed, schema-violating, illegible and truncated answers recover nothing but are still billed and never retried',
  { skip },
  async () => {
    const replies = [
      { text: 'not json at all' },
      { text: JSON.stringify({ legible: true, lines: 'a string, not an array' }) },
      { text: JSON.stringify({ legible: false, lines: [] }) },
    ];
    const p = fakeProvider((n) => replies[(n - 1) % 3]!);
    const cache = new InMemoryRecoveryCache();
    const first = await recoverUnreadPages(load(), bytes, [tierOf(p)], { maxCostUsd: 1 }, cache);
    assert.equal(first.ledger.pagesRecovered, 0);
    assert.ok(first.ledger.totalCostUsd > 0, 'a call that was made is paid for');
    const calls = p.requests.length;
    const second = await recoverUnreadPages(load(), bytes, [tierOf(p)], { maxCostUsd: 1 }, cache);
    assert.equal(p.requests.length, calls, 'the same pages are not sent again');
    assert.equal(second.ledger.totalCostUsd, 0);
    const truncated = fakeProvider(() => ({ ...GOOD(), finishReason: 'length' as const }));
    const t = await recoverUnreadPages(load(), bytes, [tierOf(truncated)], { maxCostUsd: 1 });
    assert.equal(t.ledger.pagesRecovered, 0);
  },
);

test('vision: a ceiling that fits one call is never overrun by pages running in parallel', { skip }, async () => {
  const p = fakeProvider(() => GOOD());
  const one = tierOf(p).estimateCostUsd!({} as never);
  const { ledger } = await recoverUnreadPages(load(), bytes, [tierOf(p)], { maxCostUsd: one * 1.5, concurrency: 8 });
  assert.equal(p.requests.length, 1);
  assert.ok(ledger.totalCostUsd <= one * 1.5);
});

// UW-3 — a phone photo of a certificate uploaded through the API is read (not just stored), and the reading is reported on the compilation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageTier } from '@xo/compiler';
import { resolveResidency } from '@xo/ai-core';
import { TestServer, withTempDir } from './test-helpers.js';
import { extractionFromEnv } from '../src/compilations/extraction-tiers.js';
import type { ModelProvider } from '../src/chat/model-provider.js';

// A minimal valid PNG header (IHDR 1200×1600): the bytes the image frontend sniffs; the stub tier stands in for the OCR engine.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0xb0, 0, 0, 0x06, 0x40, 8, 0, 0, 0, 0,
]);

const photoReader: PageTier = {
  name: 'stub-photo-ocr',
  version: '1',
  costClass: 'local',
  acceptsImages: true,
  handles: () => true,
  async recover() {
    return {
      lines: [
        { text: 'Certificate of Insurance', x: 40, y: 1500, fontSizePt: 18 },
        { text: 'This is to certify that Asha Rao holds policy P-9. Valid until 31 March 2027.', x: 40, y: 1460, fontSizePt: 11 },
      ],
      confidence: 0.9,
    };
  },
};

interface CompilationWire {
  status: string;
  sourceReport?: {
    coverage?: { ocrPages: number; unaccountedPages: number };
    textRecovery?: {
      pagesNeedingRecovery: number;
      pagesRecovered: number;
      tiers: { tier: string; recovered: number }[];
      totalCostUsd: number;
    };
    kindProposals: { kind: string }[];
  };
}

test('UW-3 API: an uploaded phone photo is read by the server’s OCR tiers and the compilation reports what was read', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, extraction: { pageTiers: [photoReader] } });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const up = await server.request('POST', `/workspaces/${ws}/sources?filename=IMG_2041.jpg`, PNG);
      assert.equal(up.status, 201, up.bodyText);
      const res = await server.request('POST', `/workspaces/${ws}/sources/${up.json<{ sourceId: string }>().sourceId}/compile`);
      const rec = res.json<CompilationWire>();
      assert.equal(rec.status, 'succeeded', res.bodyText);
      assert.deepEqual([rec.sourceReport?.coverage?.ocrPages, rec.sourceReport?.coverage?.unaccountedPages], [1, 0]);
      assert.equal(rec.sourceReport?.textRecovery?.pagesRecovered, 1);
      assert.deepEqual(
        rec.sourceReport?.textRecovery?.tiers.map((t) => [t.tier, t.recovered]),
        [['stub-photo-ocr', 1]],
      );
      assert.equal(rec.sourceReport?.textRecovery?.totalCostUsd, 0, 'local reading costs nothing');
      assert.equal(rec.sourceReport?.kindProposals[0]?.kind, 'certificate', 'proposed from the words on the photo');
    } finally {
      await server.stop();
    }
  });
});

test('UW-3 API: OCR configuration — local by default, explicit off, and vision only with every confirmation in place', () => {
  const none = () => undefined;
  assert.deepEqual(
    extractionFromEnv({}, none).pageTiers.map((t) => t.name),
    ['pdfium-text', 'tesseract-ocr'],
  );
  assert.equal(extractionFromEnv({}, none).extractionBudget?.maxCostUsd, 0, 'no paid reading unless a budget is set');
  assert.deepEqual(extractionFromEnv({ XO_OCR: 'off' }, none).pageTiers, []);
  assert.throws(() => extractionFromEnv({ XO_OCR: 'cloud' }, none), /XO_OCR must be/);
  assert.throws(() => extractionFromEnv({ XO_OCR_WORKERS: '0' }, none), /XO_OCR_WORKERS/);
  assert.throws(() => extractionFromEnv({ XO_OCR_VISION_PROVIDER: 'anthropic' }, none), /XO_OCR_VISION_MODEL/);
  const vision = { XO_OCR_VISION_PROVIDER: 'anthropic', XO_OCR_VISION_MODEL: 'claude-sonnet-5-5' };
  assert.throws(
    () => extractionFromEnv(vision, none),
    /XO_OCR_VISION_SENDS_IMAGES=yes/,
    'sending images off the machine is confirmed, not assumed',
  );
  assert.throws(() => extractionFromEnv({ ...vision, XO_OCR_VISION_SENDS_IMAGES: 'yes' }, none), /not configured on this server/);
  const provider = { id: 'anthropic', describeCapabilities: () => ({ supportsVision: true }) } as unknown as ModelProvider;
  // UW-14: a hosted vision provider is only possible in open residency (docs/RESIDENCY.md); residency.test.ts covers the refusals.
  const open = resolveResidency({ XO_RESIDENCY: 'open' });
  const configured = extractionFromEnv({ ...vision, XO_OCR_VISION_SENDS_IMAGES: 'yes', XO_OCR_MAX_COST_USD: '0.5' }, () => provider, open);
  assert.equal(configured.pageTiers.length, 3);
  assert.equal(configured.extractionBudget?.maxCostUsd, 0.5);
  assert.throws(
    () => extractionFromEnv({ ...vision, XO_OCR_VISION_SENDS_IMAGES: 'yes', XO_OCR_MAX_COST_USD: '-1' }, () => provider, open),
    /XO_OCR_MAX_COST_USD/,
  );
});

import { createPdfiumReaderTier, createTesseractTier, createVisionTier, type ExtractionBudget, type PageTier } from '@xo/compiler';
import { envProviderFactory, type ProviderFactory } from '../chat/model-provider.js';

/**
 * UW-3 — how this instance reads pages and photos that have no text layer (scanned PDFs, phone photos of certificates). Built once
 * from server configuration and handed to every compile:
 *
 * - `XO_OCR` = `local` (default) | `off`. Local reading: a second PDF reader (pdfium) for pages whose text layer is unreadable, then
 *   OCR on this machine (tesseract) for scans and photos. Nothing leaves the machine. Both engines are optional dependencies; where
 *   they are not installed the tiers report themselves unavailable and pages stay visibly unaccounted.
 * - Vision (off unless configured): `XO_OCR_VISION_PROVIDER` (a provider configured for this server, e.g. `anthropic`),
 *   `XO_OCR_VISION_MODEL`, `XO_OCR_VISION_SENDS_IMAGES=yes` (required: page images and photos are sent to that provider), and
 *   `XO_OCR_MAX_COST_USD` (per document; default 0, which means the model is never called). It runs only where local reading did not
 *   reach the confidence floor.
 */
export interface CompileExtraction {
  readonly pageTiers: readonly PageTier[];
  readonly extractionBudget?: ExtractionBudget;
}

export function extractionFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  providers: ProviderFactory = envProviderFactory(env),
): CompileExtraction {
  const mode = (env['XO_OCR'] ?? 'local').trim().toLowerCase();
  if (mode !== 'local' && mode !== 'off') throw new Error(`XO_OCR must be "local" or "off" (got "${env['XO_OCR']}")`);
  const tiers: PageTier[] = [];
  if (mode === 'local') {
    const workers = Number(env['XO_OCR_WORKERS'] ?? '2');
    if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new Error('XO_OCR_WORKERS must be 1 to 16');
    tiers.push(createPdfiumReaderTier(), createTesseractTier({ workers }));
  }
  const providerId = env['XO_OCR_VISION_PROVIDER']?.trim();
  let maxCostUsd = 0;
  if (providerId !== undefined && providerId !== '') {
    const model = env['XO_OCR_VISION_MODEL']?.trim();
    if (model === undefined || model === '') throw new Error('XO_OCR_VISION_PROVIDER is set but XO_OCR_VISION_MODEL is not');
    if (env['XO_OCR_VISION_SENDS_IMAGES'] !== 'yes') {
      throw new Error(
        'XO_OCR_VISION_PROVIDER is set: also set XO_OCR_VISION_SENDS_IMAGES=yes to confirm page images and photos may be sent to it',
      );
    }
    const provider = providers(providerId);
    if (provider === undefined)
      throw new Error(`XO_OCR_VISION_PROVIDER "${providerId}" is not configured on this server (missing its key)`);
    maxCostUsd = Number(env['XO_OCR_MAX_COST_USD'] ?? '0');
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 100)
      throw new Error('XO_OCR_MAX_COST_USD must be 0 to 100 (per document)');
    tiers.push(createVisionTier({ provider, model, acknowledgeDataLeavesMachine: true }));
  }
  return { pageTiers: tiers, extractionBudget: { maxCostUsd } };
}

import { createPdfiumReaderTier, createTesseractTier, createVisionTier, type ExtractionBudget, type PageTier } from '@xo/compiler';
import { envProviderFactory, type ProviderFactory } from '../chat/model-provider.js';
import { providerLocality, resolveResidency, type ResidencyPolicy } from '@xo/ai-core';

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
  providers?: ProviderFactory,
  residency: ResidencyPolicy = resolveResidency(env),
): CompileExtraction {
  const factory = providers ?? envProviderFactory(env, residency);
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
    const provider = factory(providerId);
    if (provider === undefined)
      throw new Error(`XO_OCR_VISION_PROVIDER "${providerId}" is not configured on this server (missing its key)`);
    // UW-14 (ADR 0020): reading a page is a data-bearing path. Page images and photos are real data, never masked, so a hosted vision
    // provider is refused in strict_local and in masked_hosted; only a model on this server, or open residency (development), reads them.
    const locality = providerLocality(
      providerId,
      providerId === 'ollama' ? (env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434') : undefined,
    );
    if (locality === 'hosted' && residency.mode !== 'open') {
      throw new Error(
        `XO_OCR_VISION_PROVIDER "${providerId}" is a hosted model, and page images are real customer data: XO_RESIDENCY=${residency.mode} never sends them. Use a vision model on this server (Ollama), or XO_RESIDENCY=open for development.`,
      );
    }
    maxCostUsd = Number(env['XO_OCR_MAX_COST_USD'] ?? '0');
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 100)
      throw new Error('XO_OCR_MAX_COST_USD must be 0 to 100 (per document)');
    tiers.push(createVisionTier({ provider, model, acknowledgeDataLeavesMachine: true }));
  }
  return { pageTiers: tiers, extractionBudget: { maxCostUsd } };
}

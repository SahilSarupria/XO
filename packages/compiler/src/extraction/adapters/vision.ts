import { computeCostUsd, validateJsonSchema, DEFAULT_PRICING_TABLE, type ModelProvider, type PricingTable } from '@xo/ai-core';
import { needsEngineHelp } from '../router.js';
import type { PageRecovery, PageTier } from '../types.js';
import { cropToContent, encodeGrayPng } from './png.js';
import { renderPageGray, textPlausibility } from './pdfium.js';

/**
 * Hosted vision-model tier. OFF unless a caller builds it: nothing in the default pipeline constructs one, and the
 * router's default budget is zero, so even a configured tier is skipped until a spend ceiling is set.
 *
 * Properties, each covered by tests:
 *  - the page image is rendered locally, cropped to its content and capped in size BEFORE it leaves the machine;
 *  - the worst-case cost is reserved against the document and run ceilings before the call (router), and a model with
 *    no known price is never callable (an unpriced model would reserve zero and bypass every ceiling);
 *  - output is a strict JSON shape validated with ai-core's schema validator; anything else is rejected;
 *  - the model's own confidence is only an UPPER bound: the tier's confidence is also limited by a local plausibility
 *    check and is capped at 0.9, and the page is marked as model-transcribed so the source cannot be `trusted`;
 *  - a page is asked of the model at most once per (document, page, model, settings): the router caches the answer,
 *    including a rejected one, and de-duplicates concurrent identical requests.
 */
export interface VisionTierOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** REQUIRED. Page images are sent to the provider; setting this states that doing so is permitted for these documents. */
  readonly acknowledgeDataLeavesMachine: true;
  /** Price per 1k tokens for `model`. Default: the ai-core table. A model absent from both can never be called. */
  readonly pricing?: { readonly inputPerThousand: number; readonly outputPerThousand: number };
  readonly pricingTable?: PricingTable;
  /** Longest image edge in pixels. Smaller is cheaper. Default 1568. */
  readonly maxLongEdge?: number;
  readonly maxOutputTokens?: number;
}

const SCHEMA = {
  type: 'object',
  required: ['legible', 'lines'],
  additionalProperties: false,
  properties: {
    legible: { type: 'boolean' },
    lines: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const SYSTEM =
  'You transcribe one scanned page of an insurance document. Copy the visible text exactly, line by line, in reading order. ' +
  'Do not summarise, correct, translate, complete or infer anything. If the page is not legible, set legible to false and return no lines. ' +
  'Respond with JSON only.';

/** Upper bound on image tokens for an image whose longest edge is capped (about one token per 750 px, rounded up generously). */
const imageTokenBound = (longEdge: number): number => Math.ceil((longEdge * longEdge) / 512) + 200;
const PROMPT_TOKENS = 250;
export const VISION_CONFIDENCE_CAP = 0.9;

export function createVisionTier(options: VisionTierOptions): PageTier {
  if ((options as { acknowledgeDataLeavesMachine?: unknown }).acknowledgeDataLeavesMachine !== true) {
    throw new Error('createVisionTier: set acknowledgeDataLeavesMachine: true to confirm page images may be sent to the provider');
  }
  const { provider, model } = options;
  const longEdge = options.maxLongEdge ?? 1568;
  const maxOut = options.maxOutputTokens ?? 1500;
  const table = options.pricingTable ?? DEFAULT_PRICING_TABLE;
  const price = options.pricing ?? table[provider.id]?.[model];
  const priced = price !== undefined && (price.inputPerThousand > 0 || price.outputPerThousand > 0);
  const pricingTable: PricingTable = { ...table, [provider.id]: { ...(table[provider.id] ?? {}), ...(price ? { [model]: price } : {}) } };
  const supportsVision = provider.describeCapabilities().supportsVision;

  return {
    name: `vision:${provider.id}:${model}`,
    version: `1|${longEdge}|${maxOut}`,
    costClass: 'model',
    handles: (page) => needsEngineHelp(page) && supportsVision,
    estimateCostUsd: () => {
      if (!priced || !supportsVision) return Number.POSITIVE_INFINITY; // never callable
      return computeCostUsd(
        provider.id,
        model,
        { inputTokens: imageTokenBound(longEdge) + PROMPT_TOKENS, outputTokens: maxOut },
        pricingTable,
      );
    },
    async recover({ page, bytes, signal }): Promise<PageRecovery | undefined> {
      if (signal?.aborted === true) return undefined;
      const rendered = await renderPageGray(bytes, page.pageNumber, { dpi: 200, maxLongEdge: longEdge });
      if (rendered === undefined) return undefined;
      const img = cropToContent(rendered);
      const png = encodeGrayPng(img.width, img.height, img.data);
      const res = await provider.complete({
        model,
        maxOutputTokens: maxOut,
        temperature: 0,
        responseSchema: SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'Transcribe this page.', images: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] },
        ],
      });
      const costUsd = computeCostUsd(provider.id, model, res.usage, pricingTable);
      const tokensUsed = res.usage.inputTokens + res.usage.outputTokens;
      const parsed = parseStrict(res.text);
      if (parsed === undefined || res.finishReason !== 'stop') return { lines: [], confidence: 0, tokensUsed, costUsd };
      if (!parsed.legible || parsed.lines.length === 0) return { lines: [], confidence: 0, tokensUsed, costUsd };
      const joined = parsed.lines.join('\n');
      const confidence = Math.min(VISION_CONFIDENCE_CAP, parsed.confidence ?? VISION_CONFIDENCE_CAP, textPlausibility(joined));
      const [, , , top] = page.mediaBox;
      return {
        lines: parsed.lines.map((text, i) => ({ text, x: 72, y: top - 72 - i * 14, fontSizePt: 11 })),
        confidence: Number(confidence.toFixed(3)),
        tokensUsed,
        costUsd,
      };
    },
  };
}

function parseStrict(text: string): { legible: boolean; lines: string[]; confidence?: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return undefined;
  }
  if (validateJsonSchema(SCHEMA as never, value).length > 0) return undefined;
  return value as { legible: boolean; lines: string[]; confidence?: number };
}

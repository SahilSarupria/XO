import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { DocumentBlock } from '../document/types.js';
import { htmlDocumentBlocks } from './structured-blocks/html-blocks.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import { parsedDocumentFromBlocks, syntheticProvenance } from './block-source-helpers.js';

export interface HtmlSourceInput {
  readonly kind: 'html';
  readonly html: string;
  readonly sourcePath: string;
  /** Where this HTML was fetched from, if applicable — carried as provenance metadata only. This frontend never fetches a URL itself (Stage 8 §9: "do not build a web crawler"). */
  readonly url?: string;
}

function isHtmlSourceInput(input: unknown): input is HtmlSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<HtmlSourceInput>;
  return candidate.kind === 'html' && typeof candidate.html === 'string' && typeof candidate.sourcePath === 'string';
}

/**
 * The HTML/web-content family (Stage 8 §9). Deterministic on fixture HTML strings — this frontend never performs a network
 * request; a URL is accepted purely as a provenance label for content the caller already fetched.
 *
 * UW-3c: the page is parsed with the WHATWG parser and its main content walked (`structured-blocks/html-blocks.ts`): headings,
 * paragraphs and text in containers, ordered and bulleted lists with positions, nesting and check boxes, tables, and code. Site
 * chrome and non-content are not read. No CSS layout inference.
 */
export class HtmlSourceFrontend implements SourceFrontend<HtmlSourceInput> {
  readonly sourceType = 'html' as const;

  canHandle(input: unknown): input is HtmlSourceInput {
    return isHtmlSourceInput(input);
  }

  ingest(input: HtmlSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    if (input.html.trim().length === 0) {
      return err(
        new SourceError(ErrorCode.PRECONDITION_FAILED, `HTML source "${input.sourcePath}" has no content`, {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }

    const read = htmlDocumentBlocks(input.html);
    const rawBlocks = read.blocks;
    if (rawBlocks.length === 0) {
      return err(
        new SourceError(
          ErrorCode.SERIALIZATION_PARSE_FAILED,
          `HTML source "${input.sourcePath}" contained no recognizable heading/paragraph/list content`,
          {
            context: { sourcePath: input.sourcePath },
          },
        ),
      );
    }

    const total = rawBlocks.length;
    const blocks: DocumentBlock[] = rawBlocks.map((b, i) => ({ ...b, provenance: syntheticProvenance(1, i, total) }) as DocumentBlock);
    const parsed = parsedDocumentFromBlocks(blocks);

    const documentTitle = read.title;
    const plainText = rawBlocks.map((b) => (b.kind === 'table_row' ? b.cells.join(' | ') : b.text)).join('\n\n');
    const sourceId = computeSourceId('html', input.sourcePath, input.html);

    const metadata: Record<string, string> = { blockCount: String(total) };
    if (input.url !== undefined) metadata.url = input.url;

    return ok({
      sourceId,
      sourceType: 'html',
      sourcePath: input.sourcePath,
      content: { kind: 'document', parsed, documentTitle, plainText },
      metadata,
      semanticExtractionAvailable: true,
    });
  }
}

import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { DocumentBlock } from '../document/types.js';
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

const ENTITY_MAP: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITY_MAP[entity] ?? whole;
  });
}

function stripInnerTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const BLOCK_TAG_RE = /<(h[1-6]|p|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;

// See `document-frontend.ts`'s identical type for why this must
// distribute explicitly rather than using a plain `Omit`.
type UnplacedBlock = DocumentBlock extends infer B ? (B extends DocumentBlock ? Omit<B, 'provenance'> : never) : never;

function classifyHtml(html: string): UnplacedBlock[] {
  // Strip non-content elements entirely before scanning for block tags,
  // so e.g. a `<p>` inside a `<script>` template string is never
  // mistaken for real page content.
  const withoutNonContent = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  const blocks: UnplacedBlock[] = [];
  for (const match of withoutNonContent.matchAll(BLOCK_TAG_RE)) {
    const tag = match[1]!.toLowerCase();
    const text = stripInnerTags(match[2]!);
    if (text.length === 0) continue;
    if (tag === 'p') {
      blocks.push({ kind: 'paragraph', text });
    } else if (tag === 'li') {
      // This frontend does not track whether an `<li>` sits under `<ol>` or
      // `<ul>` (matching only the `<li>` tag itself, not its ancestor —
      // see `BLOCK_TAG_RE` above); its `marker` was already hardcoded to
      // `'-'` regardless of true list type before this field existed, so
      // `'unordered'` is the honest, non-regressing default rather than a
      // guess. Distinguishing `<ol>`/`<ul>` would be new HTML-structure
      // parsing, out of this task's scope (P0.9A area E: no generalized
      // source-adapter work).
      blocks.push({ kind: 'list_item', marker: '-', listKind: 'unordered', text });
    } else {
      blocks.push({ kind: 'heading', level: Number(tag[1]), text });
    }
  }
  return blocks;
}

/**
 * The HTML/web-content family (Stage 8 §9). Deterministic on fixture
 * HTML strings — this frontend never performs a network request; a URL
 * is accepted purely as a provenance label for content the caller
 * already fetched. Extraction is intentionally minimal (headings,
 * paragraphs, list items — no table support, no CSS-based layout
 * inference) rather than a general-purpose readability/boilerplate-
 * removal engine, per Stage 8 §2's "do not overbuild."
 */
export class HtmlSourceFrontend implements SourceFrontend<HtmlSourceInput> {
  readonly sourceType = 'html' as const;

  canHandle(input: unknown): input is HtmlSourceInput {
    return isHtmlSourceInput(input);
  }

  ingest(input: HtmlSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    if (input.html.trim().length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `HTML source "${input.sourcePath}" has no content`, { context: { sourcePath: input.sourcePath } }));
    }

    const rawBlocks = classifyHtml(input.html);
    if (rawBlocks.length === 0) {
      return err(
        new SourceError(ErrorCode.SERIALIZATION_PARSE_FAILED, `HTML source "${input.sourcePath}" contained no recognizable heading/paragraph/list content`, {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }

    const total = rawBlocks.length;
    const blocks: DocumentBlock[] = rawBlocks.map((b, i) => ({ ...b, provenance: syntheticProvenance(1, i, total) }) as DocumentBlock);
    const parsed = parsedDocumentFromBlocks(blocks);

    const titleMatch = TITLE_RE.exec(input.html);
    const documentTitle = titleMatch ? stripInnerTags(titleMatch[1]!) : undefined;
    const plainText = rawBlocks.map((b) => ('text' in b ? b.text : '')).join('\n\n');
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

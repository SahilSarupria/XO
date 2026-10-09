import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { DocumentBlock } from '../document/types.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import { parsedDocumentFromBlocks, syntheticProvenance } from './block-source-helpers.js';

export interface DocumentSourceInput {
  readonly kind: 'document';
  readonly text: string;
  readonly sourcePath: string;
  readonly title?: string;
}

function isDocumentSourceInput(input: unknown): input is DocumentSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<DocumentSourceInput>;
  return candidate.kind === 'document' && typeof candidate.text === 'string' && typeof candidate.sourcePath === 'string';
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^(\d+[.)]|[-*+])\s+(.*)$/;

/**
 * The "Document" family (Stage 8 §7): plain-text and lightly-marked-up
 * (markdown-style `#` headings, `-`/`*`/`1.` list items) text documents
 * that don't come from a PDF at all — a Slack export already flattened
 * to text, a plain `.txt`/`.md` file, generated documentation, etc. This
 * repository has no separate DOCX/RTF ingestion to preserve (§7's "if
 * the repository already supports document inputs independently from
 * PDFs" doesn't apply here — grep confirms the only prior document input
 * was PDF), so this frontend is new capability, not a refactor, and is
 * deliberately small: a blank-line-separated-paragraph + markdown-style
 * heading/list classifier, reusing `buildSections` for structure rather
 * than reimplementing Stage 2's PDF-specific line-grouping/font-stats
 * machinery (which has nothing to measure on plain text anyway).
 */
export class DocumentSourceFrontend implements SourceFrontend<DocumentSourceInput> {
  readonly sourceType = 'document' as const;

  canHandle(input: unknown): input is DocumentSourceInput {
    return isDocumentSourceInput(input);
  }

  ingest(input: DocumentSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const trimmed = input.text.trim();
    if (trimmed.length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `Document source "${input.sourcePath}" has no content`, { context: { sourcePath: input.sourcePath } }));
    }

    const rawBlocks = classifyLines(input.text);
    const total = rawBlocks.length;
    const blocks: DocumentBlock[] = rawBlocks.map((b, i) => ({ ...b, provenance: syntheticProvenance(1, i, total) }) as DocumentBlock);
    const parsed = parsedDocumentFromBlocks(blocks);
    const sourceId = computeSourceId('document', input.sourcePath, input.text);

    return ok({
      sourceId,
      sourceType: 'document',
      sourcePath: input.sourcePath,
      content: { kind: 'document', parsed, documentTitle: input.title, plainText: input.text },
      metadata: { blockCount: String(total) },
      semanticExtractionAvailable: true,
    });
  }
}

// A plain `Omit<DocumentBlock, 'provenance'>` does not distribute over
// `DocumentBlock`'s union (it collapses to the shared-key subset first),
// which would silently drop `text`/`level`/`marker` from the narrower
// members. This distributes explicitly so every block kind keeps its
// own fields minus `provenance`.
type UnplacedBlock = DocumentBlock extends infer B ? (B extends DocumentBlock ? Omit<B, 'provenance'> : never) : never;

function classifyLines(text: string): UnplacedBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: UnplacedBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ').trim() });
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: headingMatch[1]!.length, text: headingMatch[2]!.trim() });
      continue;
    }

    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch) {
      flushParagraph();
      const marker = listMatch[1]!;
      blocks.push({ kind: 'list_item', marker, listKind: /^\d/.test(marker) ? 'ordered' : 'unordered', text: listMatch[2]!.trim() });
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();

  return blocks;
}

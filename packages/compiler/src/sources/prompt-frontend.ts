import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { computeSourceId } from './source-id.js';
import { stripIntentSentences } from '../prompt/interpret.js';

/**
 * A natural-language instruction authored by a person ("build X that does Y", "if A then B"). It is a `user_instruction`
 * source: what its author WANTS, not evidence of what an organisation knows. It is therefore a different trust class from a
 * document and only contributes to a compilation once an accountable identity has confirmed it (`confirmedBy`).
 */
export interface PromptSourceInput {
  readonly kind: 'prompt';
  readonly text: string;
  /** Human-facing label; defaults to `"prompt"`. */
  readonly sourcePath?: string;
  /** Identity of the person who reviewed the interpretation and confirmed it. Blank or absent = unconfirmed. */
  readonly confirmedBy?: string;
}

function isPromptSourceInput(input: unknown): input is PromptSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const c = input as Partial<PromptSourceInput>;
  return c.kind === 'prompt' && typeof c.text === 'string';
}

/**
 * Reuses the document frontend's block/section normalization so a confirmed prompt flows through the exact same
 * downstream pipeline as any document (one canonical representation, per the compiler spec's front-end/middle-end split).
 * Only the identity and the trust metadata differ.
 */
export class PromptSourceFrontend implements SourceFrontend<PromptSourceInput> {
  readonly sourceType = 'prompt' as const;
  private readonly documents = new DocumentSourceFrontend();

  canHandle(input: unknown): input is PromptSourceInput {
    return isPromptSourceInput(input);
  }

  ingest(input: PromptSourceInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const sourcePath = input.sourcePath ?? 'prompt';
    if (input.text.trim().length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `Prompt source "${sourcePath}" has no content`, { context: { sourcePath } }));
    }
    // Purpose statements ("build X that does Y") never enter the extraction pipeline (see `stripIntentSentences`). If
    // nothing else is left the original text is parsed instead; `compileSources` skips such a source entirely, so
    // the intents still never reach extraction.
    const compilable = stripIntentSentences(input.text);
    const doc = this.documents.ingest({ kind: 'document', text: compilable.trim().length > 0 ? compilable : input.text, sourcePath }, context);
    if (!doc.ok) return doc;
    const confirmedBy = input.confirmedBy?.trim() ?? '';
    return ok({
      ...doc.value,
      content: { ...doc.value.content, plainText: input.text },
      sourceId: computeSourceId('prompt', sourcePath, input.text),
      sourceType: 'prompt',
      metadata: {
        ...doc.value.metadata,
        sourceClass: 'user_instruction',
        confirmation: confirmedBy.length > 0 ? 'confirmed' : 'unconfirmed',
        ...(confirmedBy.length > 0 ? { confirmedBy } : {}),
      },
    });
  }
}

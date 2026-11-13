import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { computeSourceId } from './source-id.js';
import { MimeError, parseEmail, type ParsedEmail } from './mime.js';

/** An email message (.eml, RFC 5322) as raw bytes. */
export interface EmlSourceInput {
  readonly kind: 'eml';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
}

function isEmlSourceInput(input: unknown): input is EmlSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const c = input as Partial<EmlSourceInput>;
  return c.kind === 'eml' && c.bytes instanceof Uint8Array && typeof c.sourcePath === 'string';
}

/** The text the document pipeline reads: the envelope as labelled lines, then the body. */
export function emailAsText(email: ParsedEmail): string {
  const lines: string[] = [];
  if (email.subject !== undefined) lines.push(`# ${email.subject}`, '');
  for (const [label, value] of [
    ['From', email.from],
    ['To', email.to],
    ['Cc', email.cc],
    ['Date', email.date],
  ] as const) {
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  if (email.attachments.length > 0) {
    lines.push(`Attachments: ${email.attachments.map((a) => a.filename ?? `(unnamed ${a.contentType})`).join(', ')}`);
  }
  lines.push('', email.body);
  return lines.join('\n').trim();
}

/**
 * UW-3 — email messages. The envelope (from, to, cc, date, subject, message id) and the attachment list ride on the source's metadata
 * and `email` content; the text (envelope lines and the readable body) flows through the shared document pipeline like any document.
 * Attachments are listed with their SHA-256 and are not read here: each becomes its own source when it is ingested.
 */
export class EmlSourceFrontend implements SourceFrontend<EmlSourceInput> {
  readonly sourceType = 'eml' as const;
  private readonly documents = new DocumentSourceFrontend();

  canHandle(input: unknown): input is EmlSourceInput {
    return isEmlSourceInput(input);
  }

  ingest(input: EmlSourceInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    let email: ParsedEmail;
    try {
      email = parseEmail(input.bytes);
    } catch (cause) {
      const message = cause instanceof MimeError ? cause.message : (cause as Error).message;
      return err(
        new SourceError(ErrorCode.PRECONDITION_FAILED, `could not read this email: ${message}`, {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }
    const text = emailAsText(email);
    if (email.body.length === 0 && email.subject === undefined) {
      return err(
        new SourceError(ErrorCode.PRECONDITION_FAILED, 'the email has no subject and no readable body', {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }
    const doc = this.documents.ingest({ kind: 'document', text, sourcePath: input.sourcePath }, context);
    if (!doc.ok) return doc;
    if (doc.value.content.kind !== 'document') return doc;
    const meta: Record<string, string> = { format: 'eml', bodySource: email.bodySource, attachmentCount: String(email.attachments.length) };
    for (const [k, v] of [
      ['from', email.from],
      ['to', email.to],
      ['date', email.date],
      ['subject', email.subject],
      ['messageId', email.messageId],
    ] as const) {
      if (v !== undefined) meta[k] = v;
    }
    return ok({
      ...doc.value,
      sourceId: computeSourceId('eml', input.sourcePath, text),
      sourceType: 'eml',
      content: { ...doc.value.content, email },
      metadata: { ...doc.value.metadata, ...meta },
    });
  }
}

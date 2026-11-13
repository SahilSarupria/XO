import { extname } from 'node:path';
import type { EmailAttachment } from '@xo/compiler';
import { EXTENSION_FOR_MEDIA_TYPE, SUPPORTED_EXTENSIONS } from './source.js';

/**
 * UW-3 — which attachments of an uploaded email are opened as sources of their own, under what name, and why the others are not.
 * Pure: the route stores what this plans, through the same door as any upload (same format checks, same audit), so an attachment is
 * never trusted more than the file would be if someone uploaded it directly.
 */
export const EMAIL_ATTACHMENT_LIMITS = {
  /** Attachments opened per email; the rest are listed with the reason. */
  maxOpened: 20,
  /** Emails attached inside emails are opened up to this many levels below the uploaded one (a forward of a forward); deeper ones are listed. */
  maxEmailDepth: 2,
  /** A part shown inside the body (Content-ID) smaller than this is treated as decoration (signature logo, tracking pixel). */
  inlineDecorationBytes: 16 * 1024,
} as const;

export type AttachmentPlan =
  | { readonly open: true; readonly attachment: EmailAttachment; readonly filename: string; readonly extension: string }
  | { readonly open: false; readonly attachment: EmailAttachment; readonly reason: string; readonly sameAsPart?: string };

/** A filename from inside an email is untrusted: keep only its last path segment, printable, no `..`, bounded. */
export function safeAttachmentName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const last = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\.+/g, '.')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned.length === 0) return undefined;
  if (cleaned.length <= 200) return cleaned;
  const ext = extname(cleaned);
  return cleaned.slice(0, 200 - ext.length) + ext;
}

export function planEmailAttachments(attachments: readonly EmailAttachment[], emailDepth: number): readonly AttachmentPlan[] {
  const plans: AttachmentPlan[] = [];
  const firstPartBySha = new Map<string, string>();
  let opened = 0;
  for (const a of attachments) {
    const skip = (reason: string, sameAsPart?: string): void => {
      plans.push({ open: false, attachment: a, reason, ...(sameAsPart !== undefined ? { sameAsPart } : {}) });
    };
    if (a.size === 0) {
      skip('it is empty');
      continue;
    }
    if (a.inline && a.size < EMAIL_ATTACHMENT_LIMITS.inlineDecorationBytes && a.contentType.startsWith('image/')) {
      skip('a small image shown inside the message (a signature logo or similar)');
      continue;
    }
    const earlier = firstPartBySha.get(a.sha256);
    if (earlier !== undefined) {
      skip(`identical to part ${earlier}, which is stored once`, earlier);
      continue;
    }
    const named = safeAttachmentName(a.filename);
    let extension = named !== undefined ? extname(named).toLowerCase() : '';
    let filename = named;
    if (a.contentType === 'message/rfc822') extension = '.eml';
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      const byType = EXTENSION_FOR_MEDIA_TYPE[a.contentType];
      if (extension !== '' && a.contentType !== 'message/rfc822') {
        skip(`${extension} is not a format this server reads`);
        continue;
      }
      if (byType === undefined) {
        skip(`its type (${a.contentType}) is not a format this server reads`);
        continue;
      }
      extension = byType;
    }
    if (filename === undefined) filename = `attachment-${a.part}${extension}`;
    else if (extname(filename).toLowerCase() !== extension) filename = `${filename}${extension}`;
    if (extension === '.eml' && emailDepth + 1 > EMAIL_ATTACHMENT_LIMITS.maxEmailDepth) {
      skip(`it is an email nested more than ${EMAIL_ATTACHMENT_LIMITS.maxEmailDepth} levels deep`);
      continue;
    }
    if (opened >= EMAIL_ATTACHMENT_LIMITS.maxOpened) {
      skip(`only the first ${EMAIL_ATTACHMENT_LIMITS.maxOpened} attachments of an email are opened; upload it on its own`);
      continue;
    }
    if (a.content === undefined) {
      skip('its bytes were not kept by the reader');
      continue;
    }
    opened++;
    firstPartBySha.set(a.sha256, a.part);
    plans.push({ open: true, attachment: a, filename, extension });
  }
  return plans;
}

/**
 * UW-3 — dependency-free RFC 5322 / MIME reader for .eml files: header unfolding, RFC 2047 encoded words, multipart (mixed, alternative,
 * related, nested), quoted-printable and base64 transfer encodings, and the declared charset. Attachments are listed (name, type, size,
 * SHA-256) and never interpreted here. Message text is data, never instructions (trust boundary T2).
 *
 * Refused loudly: input with no header block, NUL bytes in headers, nesting or part counts past the limits, and base64 that is not
 * base64. A charset the platform cannot decode is read as UTF-8 and reported, never silently mangled.
 */
import { createHash } from 'node:crypto';

export const MIME_LIMITS = { maxDepth: 10, maxParts: 500, maxHeaderBytes: 256 * 1024 } as const;

export class MimeError extends Error {}

export interface MimeHeader {
  readonly name: string;
  /** Decoded value (encoded words resolved, folding removed). */
  readonly value: string;
}

export interface EmailAttachment {
  readonly filename?: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  /** Where in the MIME tree it sits, e.g. `1.2`. */
  readonly part: string;
  /**
   * Shown inside the message body rather than attached (a `Content-ID` part without `attachment` disposition): signature logos,
   * tracking pixels, but also a photo pasted into the body.
   */
  readonly inline: boolean;
  /** The decoded bytes — only when `parseEmail(bytes, { withContent: true })` asked for them. */
  readonly content?: Uint8Array;
}

export interface ParseEmailOptions {
  /** Keep each attachment's decoded bytes (`EmailAttachment.content`) so the caller can open it. Default false: listed only. */
  readonly withContent?: boolean;
}

export interface ParsedEmail {
  readonly headers: readonly MimeHeader[];
  readonly from?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly date?: string;
  readonly subject?: string;
  readonly messageId?: string;
  /** The readable body: text/plain when the message has it, otherwise its HTML reduced to text. */
  readonly body: string;
  readonly bodySource: 'text/plain' | 'text/html' | 'none';
  /** Which MIME part the body came from (`1`, `1.1`, ...). */
  readonly bodyPart?: string;
  readonly attachments: readonly EmailAttachment[];
  readonly findings: readonly string[];
}

interface Part {
  readonly headers: readonly MimeHeader[];
  readonly body: Buffer;
}

function splitHeaderBlock(buf: Buffer): { headerText: string; body: Buffer } {
  const text = buf.toString('latin1');
  const m = /\r?\n\r?\n/.exec(text);
  if (m === null) return { headerText: text, body: Buffer.alloc(0) };
  return { headerText: text.slice(0, m.index), body: buf.subarray(m.index + m[0].length) };
}

function parseHeaders(headerText: string, findings: string[]): MimeHeader[] {
  if (headerText.length > MIME_LIMITS.maxHeaderBytes)
    throw new MimeError(`the header block is larger than ${MIME_LIMITS.maxHeaderBytes} bytes`);
  if (headerText.includes('\u0000')) throw new MimeError('the headers contain NUL bytes');
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers: MimeHeader[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (m === null) continue;
    headers.push({ name: m[1]!.toLowerCase(), value: decodeEncodedWords(Buffer.from(m[2]!, 'latin1').toString('utf8'), findings).trim() });
  }
  return headers;
}

function decodeCharset(bytes: Buffer, charset: string | undefined, findings: string[]): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(bytes);
  } catch {
    findings.push(`charset "${label}" is not supported; the text was read as UTF-8`);
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** RFC 2047: =?charset?B|Q?text?=, with whitespace between adjacent encoded words removed. */
export function decodeEncodedWords(value: string, findings: string[] = []): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
              'latin1',
            );
      return decodeCharset(bytes, charset.split('*')[0], findings);
    });
}

function header(headers: readonly MimeHeader[], name: string): string | undefined {
  return headers.find((h) => h.name === name)?.value;
}

/** `text/plain; charset="utf-8"; format=flowed` -> type and lower-cased parameters (RFC 2231 continuations are joined). */
export function parseContentType(value: string | undefined): { type: string; params: Readonly<Record<string, string>> } {
  if (value === undefined) return { type: 'text/plain', params: { charset: 'us-ascii' } };
  const [type, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]*))/.exec(p);
    if (m === null) continue;
    const key = m[1]!.toLowerCase().replace(/\*\d*\*?$/, '');
    const raw = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    const v = /\*$/.test(m[1]!) && /^[^']*'[^']*'/.test(raw) ? decodeURIComponent(raw.replace(/^[^']*'[^']*'/, '')) : raw;
    params[key] = (params[key] ?? '') + v;
  }
  return { type: (type ?? 'text/plain').trim().toLowerCase(), params };
}

function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '7bit').trim().toLowerCase();
  if (enc === 'base64') {
    const text = body.toString('latin1').replace(/[\r\n\t ]/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new MimeError('a base64 part contains characters that are not base64');
    return Buffer.from(text, 'base64');
  }
  if (enc === 'quoted-printable') {
    const text = body
      .toString('latin1')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(text, 'latin1');
  }
  return body;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseEmail(bytes: Uint8Array, options: ParseEmailOptions = {}): ParsedEmail {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findings: string[] = [];
  const { headerText, body } = splitHeaderBlock(buf);
  const headers = parseHeaders(headerText, findings);
  const known = ['from', 'to', 'date', 'subject', 'message-id', 'mime-version', 'received', 'return-path'];
  if (!headers.some((h) => known.includes(h.name))) throw new MimeError('it has no email headers (From, To, Date, Subject, ...)');

  let plain: { text: string; part: string } | undefined;
  let html: { text: string; part: string } | undefined;
  const attachments: EmailAttachment[] = [];
  let parts = 0;

  const walk = (part: Part, path: string, depth: number): void => {
    if (++parts > MIME_LIMITS.maxParts) throw new MimeError(`it has more than ${MIME_LIMITS.maxParts} MIME parts`);
    if (depth > MIME_LIMITS.maxDepth) throw new MimeError(`its MIME parts are nested more than ${MIME_LIMITS.maxDepth} deep`);
    const ct = parseContentType(header(part.headers, 'content-type'));
    const disposition = parseContentType(header(part.headers, 'content-disposition'));
    if (ct.type.startsWith('multipart/')) {
      const boundary = ct.params['boundary'];
      if (boundary === undefined || boundary.length === 0) throw new MimeError(`a ${ct.type} part (${path}) has no boundary`);
      const text = part.body.toString('latin1');
      // Delimiter lines: "--boundary" opens a part, "--boundary--" closes the multipart. Before the first is the preamble and after the
      // closing one the epilogue; neither is content.
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const delimiters = [...text.matchAll(new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g'))];
      const children: string[] = [];
      for (let i = 0; i < delimiters.length; i++) {
        const d = delimiters[i]!;
        if (d[1] === '--') break;
        const start = d.index + d[0].length;
        const end = delimiters[i + 1]?.index ?? text.length;
        children.push(text.slice(start, end));
      }
      children.forEach((piece, i) => {
        const childBuf = Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1');
        const split = splitHeaderBlock(childBuf);
        walk(
          { headers: parseHeaders(split.headerText, findings), body: split.body },
          path === '' ? `${i + 1}` : `${path}.${i + 1}`,
          depth + 1,
        );
      });
      return;
    }
    const decoded = decodeTransfer(part.body, header(part.headers, 'content-transfer-encoding'));
    const filename = disposition.params['filename'] ?? ct.params['name'];
    const isAttachment = disposition.type === 'attachment' || (filename !== undefined && !ct.type.startsWith('text/'));
    const where = path === '' ? '1' : path;
    if (!isAttachment && ct.type === 'text/plain' && plain === undefined) {
      plain = { text: decodeCharset(decoded, ct.params['charset'], findings), part: where };
      return;
    }
    if (!isAttachment && ct.type === 'text/html' && html === undefined) {
      html = { text: htmlToText(decodeCharset(decoded, ct.params['charset'], findings)), part: where };
      return;
    }
    if (ct.type === 'message/rfc822') findings.push(`part ${where} is an attached email; its text is not part of this message's body`);
    const inline = disposition.type !== 'attachment' && header(part.headers, 'content-id') !== undefined;
    attachments.push({
      ...(filename !== undefined ? { filename: decodeEncodedWords(filename, findings) } : {}),
      contentType: ct.type,
      size: decoded.length,
      sha256: createHash('sha256').update(decoded).digest('hex'),
      part: where,
      inline,
      ...(options.withContent === true ? { content: new Uint8Array(decoded) } : {}),
    });
  };
  walk({ headers, body }, '', 0);

  const chosen = plain ?? html;
  const get = (n: string) => header(headers, n);
  return {
    headers,
    ...(get('from') !== undefined ? { from: get('from')! } : {}),
    ...(get('to') !== undefined ? { to: get('to')! } : {}),
    ...(get('cc') !== undefined ? { cc: get('cc')! } : {}),
    ...(get('date') !== undefined ? { date: get('date')! } : {}),
    ...(get('subject') !== undefined ? { subject: get('subject')! } : {}),
    ...(get('message-id') !== undefined ? { messageId: get('message-id')! } : {}),
    body: (chosen?.text ?? '').replace(/\r\n/g, '\n').trim(),
    bodySource: plain !== undefined ? 'text/plain' : html !== undefined ? 'text/html' : 'none',
    ...(chosen !== undefined ? { bodyPart: chosen.part } : {}),
    attachments,
    findings,
  };
}

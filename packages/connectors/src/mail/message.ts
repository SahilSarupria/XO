import { createHash } from 'node:crypto';
import { ConnectorError } from '../types.js';

/**
 * UW-10 (ADR 0041) — the provider-independent parts of `message.send`: the deterministic Message-ID, the recipient policy, the
 * attachment check (bytes must still be the bytes that were approved) and the MIME builder. No network here.
 */
const ADDR = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const CTL = /[\r\n\u0000]/;

/** `<xo.{first 32 hex of sha256(key)}@{sender's domain}>`. The same key always gives the same Message-ID, in every tier. */
export function messageIdFor(idempotencyKey: string, sender: string): string {
  if (!ADDR.test(sender)) throw new ConnectorError('DENIED', 'invalid sender address', 'none');
  const domain = sender.slice(sender.lastIndexOf('@') + 1).toLowerCase();
  return `<xo.${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}@${domain}>`;
}

/**
 * Who may be written to. Default deny. A recipient must come from a confirmed source record (a confirmed `contact_list` role, or a
 * UW-5 `Resolved` result: the caller passes those addresses in `confirmed`) or match an explicit workspace rule set by the manage
 * role. It is never taken from model output: the model has no way to add to either list.
 */
export interface RecipientPolicy {
  readonly confirmed: ReadonlySet<string>;
  readonly rules: { readonly addresses: readonly string[]; readonly domains: readonly string[] };
}

export function checkMailRecipients(to: unknown, policy: RecipientPolicy, maxRecipients = 5): string[] {
  const list = typeof to === 'string' ? [to] : Array.isArray(to) ? to : [];
  if (list.length === 0 || list.length > maxRecipients) throw new ConnectorError('DENIED', 'recipient count is out of range', 'none');
  return list.map((r) => {
    if (typeof r !== 'string' || CTL.test(r) || !ADDR.test(r)) throw new ConnectorError('DENIED', 'invalid recipient address', 'none');
    const a = r.toLowerCase();
    const domain = a.slice(a.lastIndexOf('@') + 1);
    const ok =
      policy.confirmed.has(a) || policy.rules.addresses.some((x) => x.toLowerCase() === a) || policy.rules.domains.some((d) => d.toLowerCase() === domain);
    if (!ok) throw new ConnectorError('DENIED', 'recipient is not from a confirmed source record or a workspace recipient rule', 'none');
    return r;
  });
}

export interface AttachmentRef {
  readonly filename: string;
  readonly contentType: string;
  /** Hex sha256 of the bytes, bound when the send was approved. */
  readonly sha256: string;
}
export interface AttachmentStore {
  read(sha256: string): Promise<Uint8Array | undefined>;
}
export interface LoadedAttachment extends AttachmentRef {
  readonly bytes: Uint8Array;
}

/** Re-verifies every attachment at send time. A missing file or different bytes refuses the send before anything leaves (no effect). */
export async function loadAttachments(refs: readonly AttachmentRef[], store: AttachmentStore, maxTotalBytes: number): Promise<LoadedAttachment[]> {
  const out: LoadedAttachment[] = [];
  let total = 0;
  for (const r of refs) {
    if (!/^[0-9a-f]{64}$/.test(r.sha256)) throw new ConnectorError('DENIED', 'attachment hash is malformed', 'none');
    if (!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(r.contentType)) throw new ConnectorError('DENIED', 'attachment content type is invalid', 'none');
    const bytes = await store.read(r.sha256);
    if (bytes === undefined) throw new ConnectorError('DENIED', 'an approved attachment is no longer available', 'none');
    if (createHash('sha256').update(bytes).digest('hex') !== r.sha256)
      throw new ConnectorError('DENIED', 'an attachment no longer matches the content that was approved', 'none');
    total += bytes.byteLength;
    if (total > maxTotalBytes) throw new ConnectorError('DENIED', 'attachments exceed the size limit', 'none');
    out.push({ ...r, bytes });
  }
  return out;
}

const b64 = (b: Uint8Array | string): string => Buffer.from(b as Uint8Array).toString('base64');
const wrap = (s: string): string => s.replace(/(.{76})/g, '$1\r\n');
const encodeWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(Buffer.from(s, 'utf8'))}?=`);
const safeFile = (n: string): string => encodeWord(n.replace(/[\\/\r\n\u0000"]/g, '_').slice(0, 120));

export interface BuildInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly messageId: string;
  readonly date: Date;
  readonly attachments: readonly LoadedAttachment[];
}

/** A complete RFC 5322 message: text body plus attachments (multipart/mixed). Header values are checked for line breaks. */
export function buildMessage(m: BuildInput): string {
  for (const v of [m.from, m.subject, m.messageId, ...m.to]) if (CTL.test(v)) throw new ConnectorError('DENIED', 'a header value contains a line break', 'none');
  const boundary = `xo-${createHash('sha256').update(m.messageId).digest('hex').slice(0, 24)}`;
  const head = [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${m.date.toUTCString()}`,
    `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0',
  ];
  const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(Buffer.from(m.body, 'utf8')))];
  if (m.attachments.length === 0) return [...head, ...text, ''].join('\r\n');
  const parts = [`--${boundary}`, ...text];
  for (const a of m.attachments) {
    const name = safeFile(a.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      wrap(b64(a.bytes)),
    );
  }
  parts.push(`--${boundary}--`, '');
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}

/** The `message.send` arguments every tier accepts (the contract; ADR 0041). Validated here, never trusted. */
export interface MessageSendArgs {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly AttachmentRef[];
}

export function parseSendArgs(args: Readonly<Record<string, unknown>>): MessageSendArgs {
  const subject = args['subject'];
  const body = args['body'];
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 200 || CTL.test(subject)) throw new ConnectorError('DENIED', 'invalid subject', 'none');
  if (typeof body !== 'string') throw new ConnectorError('DENIED', 'invalid body', 'none');
  const att = args['attachments'] ?? [];
  if (!Array.isArray(att) || att.length > 10) throw new ConnectorError('DENIED', 'invalid attachments', 'none');
  const attachments = att.map((a): AttachmentRef => {
    const o = a as Record<string, unknown>;
    if (typeof o?.['filename'] !== 'string' || typeof o['contentType'] !== 'string' || typeof o['sha256'] !== 'string')
      throw new ConnectorError('DENIED', 'each attachment needs filename, contentType and sha256', 'none');
    return { filename: o['filename'], contentType: o['contentType'], sha256: o['sha256'] };
  });
  const to = args['to'];
  return { to: (Array.isArray(to) ? to : typeof to === 'string' ? [to] : []) as string[], subject, body, attachments };
}

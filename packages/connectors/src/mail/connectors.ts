import { ConnectorError, type Connector, type Json, type OperationContext } from '../types.js';
import { egress, type EgressPolicy } from '../egress.js';
import { nodeSmtpTransport, type SmtpAuth, type SmtpConfig, type SmtpTransport } from '../smtp.js';
import { imapSentLookup, type ImapConfig, type SentLookup } from './imap.js';
import { SendGovernor, type LimitDeps, type SendLimits } from './limits.js';
import {
  buildMessage,
  checkMailRecipients,
  loadAttachments,
  messageIdFor,
  parseSendArgs,
  type AttachmentStore,
  type RecipientPolicy,
} from './message.js';

/**
 * UW-10 (ADR 0041) — one `message.send` contract, three tiers.
 *   operation `send` (write):  { to, subject, body, attachments: [{ filename, contentType, sha256 }] }
 *   operation `find_sent` (read): { key }  ->  { found: true } or an ERROR (never `found: false`; see below)
 *
 * Every tier sets the Message-ID itself, derived from the idempotency key. `find_sent` is the lookup the engine uses before any
 * decision about an earlier attempt. It answers only "yes, it is there". After its retries, "not found" is an error, which the
 * engine treats as unknown: lag or a missing read capability must never read as "not sent" and cause a second send.
 * "Accepted" is not "delivered": the output says what the provider confirmed and that bounces are not tracked.
 */
export type MailTier = 'native_api' | 'smtp_imap' | 'send_only';

export interface MailCommon {
  readonly from: string;
  readonly recipientPolicy: () => RecipientPolicy;
  readonly attachments: AttachmentStore;
  readonly maxAttachmentBytes: number;
  readonly maxRecipients?: number;
  readonly limits: SendLimits;
}

export interface LookupRetry {
  /** Delays before attempts 2 and 3 (default 60 s and 120 s: three tries over two minutes). */
  readonly delaysMs?: readonly number[];
}

const DEFAULT_DELAYS = [60_000, 60_000];

async function lookupWithRetry(check: () => Promise<boolean>, retry: LookupRetry, deps: LimitDeps, signal: AbortSignal): Promise<Json> {
  const delays = retry.delaysMs ?? DEFAULT_DELAYS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    if (await check()) return { found: true };
    const d = delays[attempt];
    if (d === undefined) break;
    await sleep(d, signal);
  }
  throw new ConnectorError('FAILED', 'the message was not found in the Sent folder after retrying; a person must confirm it');
}

const delivery = (basis: string): Json => ({ status: 'accepted', basis, delivered: 'not_confirmed', bounces: 'not_tracked' });

function keyOf(ctx: OperationContext): string {
  const k = ctx.idempotencyKey;
  if (k === undefined) throw new ConnectorError('MISSING_IDEMPOTENCY_KEY', 'a send needs an idempotency key', 'none');
  return k;
}

export interface SmtpMailConfig extends MailCommon {
  readonly smtp: Pick<SmtpConfig, 'host' | 'port' | 'security'>;
  /** `smtp_imap` looks up the Sent folder; `send_only` has no lookup and every unknown outcome waits for a person. */
  readonly tier: 'smtp_imap' | 'send_only';
  readonly imap?: ImapConfig;
  /** How the SMTP login is made: an OAuth token where the host supports XOAUTH2, otherwise the app password. */
  readonly auth: (ctx: OperationContext) => SmtpAuth | undefined;
}

export interface MailDeps extends LimitDeps {
  readonly transport?: SmtpTransport;
  readonly sentLookup?: SentLookup;
  readonly retry?: LookupRetry;
}

export function smtpMailConnector(cfg: SmtpMailConfig, deps: MailDeps = {}): Connector {
  const governor = new SendGovernor(cfg.limits, deps);
  const transport = deps.transport ?? nodeSmtpTransport({ ...cfg.smtp, from: cfg.from, allowedRecipientDomains: [], maxBodyBytes: cfg.maxAttachmentBytes });
  const lookup = cfg.tier === 'smtp_imap' ? (deps.sentLookup ?? (cfg.imap !== undefined ? imapSentLookup(cfg.imap) : undefined)) : undefined;
  const operations: Connector['operations'] = {
    send: {
      sideEffect: 'write',
      execute: async (args, ctx) => {
        const a = parseSendArgs(args);
        const to = checkMailRecipients(a.to, cfg.recipientPolicy(), cfg.maxRecipients);
        const files = await loadAttachments(a.attachments, cfg.attachments, cfg.maxAttachmentBytes);
        const messageIdHeader = messageIdFor(keyOf(ctx), cfg.from);
        const raw = buildMessage({ from: cfg.from, to, subject: a.subject, body: a.body, messageId: messageIdHeader, date: new Date(), attachments: files });
        await governor.take(ctx.signal);
        await transport.send({ from: cfg.from, to, subject: a.subject, body: a.body, messageId: messageIdHeader.slice(1, -1), messageIdHeader, raw }, cfg.auth(ctx), ctx.signal);
        return { sent: true, recipients: to.length, messageId: messageIdHeader, tier: cfg.tier, delivery: delivery('smtp_250') };
      },
    },
  };
  if (lookup !== undefined)
    (operations as Record<string, Connector['operations'][string]>)['find_sent'] = {
      sideEffect: 'read',
      execute: async (args, ctx) => {
        const id = messageIdFor(String(args['key'] ?? ''), cfg.from);
        return lookupWithRetry(() => lookup.has(id, ctx.signal), deps.retry ?? {}, deps, ctx.signal);
      },
    };
  return { kind: 'smtp', operations };
}

export interface GmailConfig extends MailCommon {
  /** `https://gmail.googleapis.com` (tests: a loopback server with `allowPrivateNetwork`). */
  readonly baseUrl: string;
  readonly egress: EgressPolicy;
  /** A fresh access token for THIS call, from the credential broker (use-only). */
  readonly accessToken: (ctx: OperationContext) => Promise<string>;
  /** True only when the connection also holds a capability that can read the mailbox. `gmail.send` alone cannot search. */
  readonly canLookup: boolean;
}

const JSON_LIMIT = 4 * 1024 * 1024;

export function gmailConnector(cfg: GmailConfig, deps: MailDeps = {}): Connector {
  const governor = new SendGovernor(cfg.limits, deps);
  const call = async (ctx: OperationContext, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string) =>
    egress(
      { url: `${cfg.baseUrl}${path}`, method, headers: { ...headers, authorization: `Bearer ${await cfg.accessToken(ctx)}` }, ...(body === undefined ? {} : { body }), signal: ctx.signal },
      cfg.egress,
    );
  const operations: Record<string, Connector['operations'][string]> = {
    send: {
      sideEffect: 'write',
      execute: async (args, ctx) => {
        const a = parseSendArgs(args);
        const to = checkMailRecipients(a.to, cfg.recipientPolicy(), cfg.maxRecipients);
        const files = await loadAttachments(a.attachments, cfg.attachments, cfg.maxAttachmentBytes);
        const messageId = messageIdFor(keyOf(ctx), cfg.from);
        const raw = buildMessage({ from: cfg.from, to, subject: a.subject, body: a.body, messageId, date: new Date(), attachments: files });
        await governor.take(ctx.signal);
        const big = Buffer.byteLength(raw) > JSON_LIMIT;
        let res;
        try {
          res = big
            ? await call(ctx, 'POST', '/upload/gmail/v1/users/me/messages/send?uploadType=media', { 'content-type': 'message/rfc822' }, raw)
            : await call(ctx, 'POST', '/gmail/v1/users/me/messages/send', { 'content-type': 'application/json' }, JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }));
        } catch (e) {
          if (e instanceof ConnectorError) throw e;
          throw new ConnectorError('FAILED', 'gmail request failed'); // unknown: it may have been accepted
        }
        if (res.status === 200) {
          const id = (JSON.parse(res.body) as { id?: unknown }).id;
          return { sent: true, recipients: to.length, messageId, tier: 'native_api', providerId: typeof id === 'string' ? id : null, delivery: delivery('gmail_api') };
        }
        if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|dailyLimitExceeded|userRateLimitExceeded/.test(res.body))) {
          governor.markProviderLimited();
          throw new ConnectorError('DENIED', 'the provider limit was reached; this send was not made', 'none');
        }
        if (res.status >= 400 && res.status < 500) throw new ConnectorError('DENIED', `gmail refused the send (${res.status})`, 'none');
        throw new ConnectorError('FAILED', `gmail answered ${res.status}`); // 5xx: unknown
      },
    },
  };
  if (cfg.canLookup)
    operations['find_sent'] = {
      sideEffect: 'read',
      execute: async (args, ctx) => {
        const id = messageIdFor(String(args['key'] ?? ''), cfg.from).slice(1, -1);
        const check = async (): Promise<boolean> => {
          const r = await call(ctx, 'GET', `/gmail/v1/users/me/messages?q=${encodeURIComponent(`rfc822msgid:${id}`)}&maxResults=1`, {});
          if (r.status !== 200) throw new ConnectorError('FAILED', `gmail lookup answered ${r.status}`);
          const m = (JSON.parse(r.body) as { messages?: unknown[] }).messages;
          return Array.isArray(m) && m.length > 0;
        };
        return lookupWithRetry(check, deps.retry ?? {}, deps, ctx.signal);
      },
    };
  return { kind: 'http', operations };
}

export interface GraphConfig extends MailCommon {
  /** `https://graph.microsoft.com` (tests: a loopback server with `allowPrivateNetwork`). */
  readonly baseUrl: string;
  readonly egress: EgressPolicy;
  readonly accessToken: (ctx: OperationContext) => Promise<string>;
  /** True only when the connection also holds a capability that can read the mailbox. `Mail.Send` alone cannot search. */
  readonly canLookup: boolean;
}

/** sendMail with a MIME body: inline attachments are limited to about 3 MB by Graph, so a bigger message is refused (the draft and upload-session flow is not built). */
const GRAPH_MIME_LIMIT = 3 * 1024 * 1024;

export function graphConnector(cfg: GraphConfig, deps: MailDeps = {}): Connector {
  const governor = new SendGovernor(cfg.limits, deps);
  const call = async (ctx: OperationContext, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string) =>
    egress(
      { url: `${cfg.baseUrl}${path}`, method, headers: { ...headers, authorization: `Bearer ${await cfg.accessToken(ctx)}` }, ...(body === undefined ? {} : { body }), signal: ctx.signal },
      cfg.egress,
    );
  const operations: Record<string, Connector['operations'][string]> = {
    send: {
      sideEffect: 'write',
      execute: async (args, ctx) => {
        const a = parseSendArgs(args);
        const to = checkMailRecipients(a.to, cfg.recipientPolicy(), cfg.maxRecipients);
        const files = await loadAttachments(a.attachments, cfg.attachments, cfg.maxAttachmentBytes);
        const messageId = messageIdFor(keyOf(ctx), cfg.from);
        const raw = buildMessage({ from: cfg.from, to, subject: a.subject, body: a.body, messageId, date: new Date(), attachments: files });
        if (Buffer.byteLength(raw) > GRAPH_MIME_LIMIT)
          throw new ConnectorError('DENIED', 'the message is larger than Microsoft Graph accepts in one call; this send was not made', 'none');
        await governor.take(ctx.signal);
        let res;
        try {
          res = await call(ctx, 'POST', '/v1.0/me/sendMail', { 'content-type': 'text/plain' }, Buffer.from(raw).toString('base64'));
        } catch (e) {
          if (e instanceof ConnectorError) throw e;
          throw new ConnectorError('FAILED', 'graph request failed'); // unknown
        }
        if (res.status === 202) return { sent: true, recipients: to.length, messageId, tier: 'native_api', delivery: delivery('graph_202') };
        if (res.status === 429) {
          governor.markProviderLimited();
          throw new ConnectorError('DENIED', 'the provider limit was reached; this send was not made', 'none');
        }
        if (res.status >= 400 && res.status < 500) throw new ConnectorError('DENIED', `graph refused the send (${res.status})`, 'none');
        throw new ConnectorError('FAILED', `graph answered ${res.status}`); // 5xx: unknown
      },
    },
  };
  if (cfg.canLookup)
    operations['find_sent'] = {
      sideEffect: 'read',
      execute: async (args, ctx) => {
        const id = messageIdFor(String(args['key'] ?? ''), cfg.from);
        const check = async (): Promise<boolean> => {
          const q = `$filter=${encodeURIComponent(`internetMessageId eq '${id}'`)}&$select=id&$top=1`;
          const r = await call(ctx, 'GET', `/v1.0/me/messages?${q}`, {});
          if (r.status !== 200) throw new ConnectorError('FAILED', `graph lookup answered ${r.status}`);
          const v = (JSON.parse(r.body) as { value?: unknown[] }).value;
          return Array.isArray(v) && v.length > 0;
        };
        return lookupWithRetry(check, deps.retry ?? {}, deps, ctx.signal);
      },
    };
  return { kind: 'http', operations };
}

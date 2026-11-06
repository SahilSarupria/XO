import { createHmac } from 'node:crypto';
import { allowlistProblem, egress, hostAllowed, type EgressDeps } from './egress.js';
import { ConnectorError, type Connector, type Json, type OperationContext } from './types.js';

/**
 * Outbound webhooks. Both connectors send to a destination the OPERATOR binds; a workflow can never name a host or a path. Both go through `egress`
 * (https, allowlist, pinned public address, no redirects, bounded bodies) and both are single-operation write connectors, so the host's existing
 * rules apply: declared, granted, idempotency key required, dry-run skips the call.
 */

export interface WebhookOutConfig {
  /** The one destination, bound by the operator. https. */
  readonly url: string;
  /** Hosts this connector may ever talk to (exact or `*.suffix`). The destination's host must be among them. */
  readonly allowedHosts: readonly string[];
  readonly allowedPorts?: readonly number[];
  /** NAME of a declared secret holding an HMAC key. When set, every request is signed. */
  readonly signingSecret?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Local development only (http / loopback). Off by default. */
  readonly allowPrivateNetwork?: boolean;
}

const EVENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function checkAllowlist(allowed: readonly string[], who: string): void {
  if (allowed.length === 0) throw new Error(`${who}: allowedHosts must list at least one host`);
  for (const a of allowed) {
    const p = allowlistProblem(a);
    if (p !== undefined && !isLoopbackEntry(a)) throw new Error(`${who}: ${p}`);
  }
}
const isLoopbackEntry = (a: string): boolean => a === 'localhost' || a === '127.0.0.1';

function scrubbed<T>(secret: string | undefined, f: () => Promise<T>): Promise<T> {
  return f().catch((e: unknown) => {
    if (secret === undefined || secret.length === 0 || !(e instanceof Error)) throw e;
    const clean = e.message.split(secret).join('[redacted]');
    throw e instanceof ConnectorError ? new ConnectorError(e.code, clean) : new ConnectorError('FAILED', clean);
  });
}

function parseBody(text: string, contentType: string): Json {
  if (!contentType.includes('json')) return text;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

/** Generic signed webhook. Operation `post` (write): `{ body: Json, event?: string }`. */
export function webhookOutConnector(cfg: WebhookOutConfig, deps: EgressDeps = {}): Connector {
  checkAllowlist(cfg.allowedHosts, 'webhook_out');
  let dest: URL;
  try {
    dest = new URL(cfg.url);
  } catch {
    throw new Error('webhook_out: url is not a valid URL');
  }
  if (dest.protocol !== 'https:' && !(cfg.allowPrivateNetwork === true && dest.protocol === 'http:'))
    throw new Error('webhook_out: url must be https');
  if (dest.username !== '' || dest.password !== '') throw new Error('webhook_out: url must not contain credentials');
  if (!hostAllowed(dest.hostname, cfg.allowedHosts))
    throw new Error(`webhook_out: destination host "${dest.hostname}" is not on allowedHosts`);
  const policy = {
    allowedHosts: cfg.allowedHosts,
    ...(cfg.allowedPorts !== undefined ? { allowedPorts: cfg.allowedPorts } : {}),
    ...(cfg.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    maxRequestBytes: cfg.maxRequestBytes ?? 262_144,
    maxResponseBytes: cfg.maxResponseBytes ?? 65_536,
  };
  return {
    kind: 'webhook_out',
    operations: {
      post: {
        sideEffect: 'write',
        execute: async (args: Readonly<Record<string, Json>>, ctx: OperationContext): Promise<Json> => {
          const extra = Object.keys(args).filter((k) => k !== 'body' && k !== 'event');
          if (extra.length > 0)
            throw new ConnectorError(
              'DENIED',
              `unknown argument(s): ${extra.join(', ')} (a workflow cannot choose headers, paths or hosts)`,
            );
          if (args['body'] === undefined) throw new ConnectorError('DENIED', 'args.body is required');
          const event = args['event'];
          if (event !== undefined && (typeof event !== 'string' || !EVENT.test(event)))
            throw new ConnectorError('DENIED', 'args.event must match [A-Za-z0-9._:-]{1,128}');
          const body = JSON.stringify(args['body']);
          const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/plain;q=0.5' };
          if (ctx.idempotencyKey !== undefined) headers['idempotency-key'] = ctx.idempotencyKey;
          if (event !== undefined) headers['x-xo-event'] = event;
          let key: string | undefined;
          if (cfg.signingSecret !== undefined) {
            key = ctx.secret(cfg.signingSecret);
            // v1 = HMAC-SHA256(key, "<timestamp>.<raw body>"). The receiver must check the timestamp is recent (replay) and compare in constant time.
            const ts = String(Math.floor(Date.now() / 1000));
            headers['x-xo-timestamp'] = ts;
            headers['x-xo-signature'] = `v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;
          }
          const res = await scrubbed(key, () => egress({ url: cfg.url, method: 'POST', headers, body, signal: ctx.signal }, policy, deps));
          if (res.status >= 500) throw new ConnectorError('FAILED', `upstream status ${res.status}`);
          return { status: res.status, ok: res.status < 400, body: parseBody(res.body, res.headers['content-type'] ?? '') };
        },
      },
    },
  };
}

export interface SlackWebhookConfig {
  /** NAME of a declared secret holding the incoming-webhook URL. The URL IS the credential, so it is never in config, a workflow or a log. */
  readonly webhookSecret: string;
  /** Default `hooks.slack.com`. Add hosts for Slack-compatible receivers (e.g. a self-hosted chat server). */
  readonly allowedHosts?: readonly string[];
  readonly allowedPorts?: readonly number[];
  /** Longest message accepted (default 3000). Longer text is refused, never silently cut. */
  readonly maxTextChars?: number;
  readonly allowPrivateNetwork?: boolean;
}

/**
 * Escapes the three characters Slack-style markup gives meaning to. Without this, text that came from a case (untrusted) could carry
 * `<!channel>`, `<!here>`, `<@U123>` or a `<https://evil|label>` link and notify everyone or disguise a link. The text arrives as plain text.
 */
export function escapeChatText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack-compatible incoming webhook. Operation `post_message` (write): `{ text: string }`. */
export function slackWebhookConnector(cfg: SlackWebhookConfig, deps: EgressDeps = {}): Connector {
  const allowedHosts = cfg.allowedHosts ?? ['hooks.slack.com'];
  checkAllowlist(allowedHosts, 'slack_webhook');
  const maxChars = cfg.maxTextChars ?? 3000;
  const policy = {
    allowedHosts,
    ...(cfg.allowedPorts !== undefined ? { allowedPorts: cfg.allowedPorts } : {}),
    ...(cfg.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    maxRequestBytes: 65_536,
    maxResponseBytes: 4096,
  };
  return {
    kind: 'slack_webhook',
    operations: {
      post_message: {
        sideEffect: 'write',
        execute: async (args: Readonly<Record<string, Json>>, ctx: OperationContext): Promise<Json> => {
          const extra = Object.keys(args).filter((k) => k !== 'text');
          if (extra.length > 0) throw new ConnectorError('DENIED', `unknown argument(s): ${extra.join(', ')}`);
          const text = args['text'];
          if (typeof text !== 'string' || text.trim().length === 0)
            throw new ConnectorError('DENIED', 'args.text must be a non-empty string');
          if (text.length > maxChars) throw new ConnectorError('DENIED', `message is ${text.length} characters; the limit is ${maxChars}`);
          const url = ctx.secret(cfg.webhookSecret);
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (ctx.idempotencyKey !== undefined) headers['idempotency-key'] = ctx.idempotencyKey;
          const res = await scrubbed(url, () =>
            egress(
              { url, method: 'POST', headers, body: JSON.stringify({ text: escapeChatText(text) }), signal: ctx.signal },
              policy,
              deps,
            ),
          );
          if (res.status >= 500) throw new ConnectorError('FAILED', `upstream status ${res.status}`);
          // a revoked / unknown hook (404, 410) or a rejected payload (400) is a permanent refusal: the message was NOT delivered
          return { status: res.status, ok: res.status < 400, body: res.body.slice(0, 200) };
        },
      },
    },
  };
}

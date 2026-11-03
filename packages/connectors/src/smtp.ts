import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ConnectorError, type Connector, type Json } from './types.js';

export interface SmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** Deterministic, derived from the idempotency key, so a repeat of the same logical send carries the same Message-ID for receivers to dedupe. */
  readonly messageId: string;
}

export interface SmtpAuth {
  readonly user: string;
  readonly password: string;
}

/** Injectable so tests and hosts can substitute delivery. The default implementation speaks SMTP over TLS or STARTTLS. */
export interface SmtpTransport {
  send(message: SmtpMessage, auth: SmtpAuth | undefined, signal: AbortSignal): Promise<void>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** `tls` = implicit TLS (465). `starttls` = upgrade before authenticating (587). `none` exists only for loopback test servers. */
  readonly security: 'tls' | 'starttls' | 'none';
  readonly from: string;
  /** Recipients must be in one of these domains. There is no default: an empty list refuses everything. */
  readonly allowedRecipientDomains: readonly string[];
  readonly maxRecipients?: number;
  readonly maxBodyBytes: number;
  readonly userSecret?: string;
  readonly passwordSecret?: string;
}

const ADDR = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const CRLF = /[\r\n\u0000]/;

export function checkRecipients(to: unknown, cfg: Pick<SmtpConfig, 'allowedRecipientDomains' | 'maxRecipients'>): string[] {
  const list = typeof to === 'string' ? [to] : Array.isArray(to) ? to : [];
  if (list.length === 0 || list.length > (cfg.maxRecipients ?? 5)) throw new ConnectorError('DENIED', 'recipient count is out of range');
  return list.map((r) => {
    if (typeof r !== 'string' || CRLF.test(r) || !ADDR.test(r)) throw new ConnectorError('DENIED', 'invalid recipient address');
    const domain = r.slice(r.lastIndexOf('@') + 1).toLowerCase();
    if (!cfg.allowedRecipientDomains.some((d) => d.toLowerCase() === domain))
      throw new ConnectorError('DENIED', `recipient domain "${domain}" is not allowed`);
    return r;
  });
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s: string): string => s.replace(/(.{76})/g, '$1\r\n');
const encodeSubject = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMime(m: SmtpMessage, date: Date): string {
  return [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    `Subject: ${encodeSubject(m.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${m.messageId}@xo.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(m.body)),
    '',
  ].join('\r\n');
}

class Session {
  private buf = '';
  private waiter: ((line: string) => void) | undefined;
  private lines: string[] = [];
  constructor(public sock: Socket | TLSSocket) {
    this.attach(sock);
  }
  attach(s: Socket | TLSSocket): void {
    this.sock = s;
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 2);
      }
      this.pump();
    });
    s.on('error', () => this.waiter?.('421 connection error'));
    s.on('close', () => this.waiter?.('421 connection closed'));
  }
  private pump(): void {
    if (this.waiter !== undefined && this.lines.length > 0) {
      const w = this.waiter;
      this.waiter = undefined;
      w(this.lines.shift() as string);
    }
  }
  private nextLine(): Promise<string> {
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.pump();
    });
  }
  /** Reads one (possibly multi-line) reply. */
  async reply(): Promise<{ code: number; text: string }> {
    const parts: string[] = [];
    for (;;) {
      const l = await this.nextLine();
      parts.push(l.slice(4));
      if (l.length < 4 || l[3] !== '-') return { code: Number(l.slice(0, 3)), text: parts.join('\n') };
    }
  }
  async cmd(line: string, ok: readonly number[]): Promise<{ code: number; text: string }> {
    this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new ConnectorError(r.code >= 500 ? 'DENIED' : 'FAILED', `smtp ${r.code}`);
    return r;
  }
}

/** Default transport. Credentials only travel after TLS is established (implicit or STARTTLS); `none` refuses to authenticate. */
export function nodeSmtpTransport(cfg: SmtpConfig): SmtpTransport {
  return {
    async send(m, auth, signal) {
      const sock: Socket | TLSSocket = await new Promise((resolve, reject) => {
        const onErr = (e: Error): void => reject(new ConnectorError('FAILED', `smtp connect failed: ${e.message}`));
        const s =
          cfg.security === 'tls'
            ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: 'TLSv1.2' }, () => resolve(s))
            : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
        s.once('error', onErr);
      });
      signal.addEventListener('abort', () => sock.destroy());
      const ses = new Session(sock);
      try {
        const greet = await ses.reply();
        if (greet.code !== 220) throw new ConnectorError('FAILED', `smtp greeting ${greet.code}`);
        const ehlo = async (): Promise<string> => (await ses.cmd('EHLO xo.local', [250])).text;
        let caps = await ehlo();
        if (cfg.security === 'starttls') {
          if (!/STARTTLS/i.test(caps)) throw new ConnectorError('DENIED', 'server does not offer STARTTLS; refusing to send in clear text');
          await ses.cmd('STARTTLS', [220]);
          const upgraded = tlsConnect({ socket: sock, servername: cfg.host, minVersion: 'TLSv1.2' });
          await new Promise<void>((res, rej) => (upgraded.once('secureConnect', res), upgraded.once('error', rej)));
          ses.attach(upgraded);
          caps = await ehlo();
        }
        if (auth !== undefined) {
          if (cfg.security === 'none') throw new ConnectorError('DENIED', 'refusing to send credentials without TLS');
          await ses.cmd(`AUTH PLAIN ${b64(`\u0000${auth.user}\u0000${auth.password}`)}`, [235]);
        }
        await ses.cmd(`MAIL FROM:<${m.from}>`, [250]);
        for (const r of m.to) await ses.cmd(`RCPT TO:<${r}>`, [250, 251]);
        await ses.cmd('DATA', [354]);
        const mime = buildMime(m, new Date()).replace(/^\./gm, '..');
        ses.sock.write(`${mime}\r\n.\r\n`);
        const done = await ses.reply();
        if (done.code !== 250) throw new ConnectorError(done.code >= 500 ? 'DENIED' : 'FAILED', `smtp ${done.code}`);
        await ses.cmd('QUIT', [221]).catch(() => undefined);
      } finally {
        sock.destroy();
      }
    },
  };
}

/** Operation `send` (write): `{ to, subject, body }`. SMTP has no idempotency: a retry after an ambiguous failure can deliver twice. */
export function smtpConnector(cfg: SmtpConfig, transport: SmtpTransport = nodeSmtpTransport(cfg)): Connector {
  if (!ADDR.test(cfg.from) || CRLF.test(cfg.from)) throw new Error('smtp connector: invalid from address');
  return {
    kind: 'smtp',
    operations: {
      send: {
        sideEffect: 'write',
        execute: async (args, ctx): Promise<Json> => {
          const to = checkRecipients(args['to'], cfg);
          const subject = args['subject'];
          const body = args['body'];
          if (typeof subject !== 'string' || subject.length === 0 || subject.length > 200 || CRLF.test(subject))
            throw new ConnectorError('DENIED', 'invalid subject');
          if (typeof body !== 'string' || Buffer.byteLength(body) > cfg.maxBodyBytes)
            throw new ConnectorError('DENIED', 'invalid or oversized body');
          let auth: SmtpAuth | undefined;
          if (cfg.userSecret !== undefined && cfg.passwordSecret !== undefined)
            auth = { user: ctx.secret(cfg.userSecret), password: ctx.secret(cfg.passwordSecret) };
          const messageId = (ctx.idempotencyKey ?? `${ctx.runId}.${ctx.stepId}`).replace(/[^A-Za-z0-9._-]/g, '');
          await transport.send({ from: cfg.from, to, subject, body, messageId }, auth, ctx.signal);
          return { sent: true, recipients: to.length, messageId };
        },
      },
    },
  };
}

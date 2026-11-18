import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { ConnectorError } from '../types.js';

/**
 * UW-10 (ADR 0041) — the smallest IMAP client that answers one question: "is a message with this Message-ID in the Sent folder?"
 * LOGIN or AUTHENTICATE XOAUTH2, find the Sent folder (SPECIAL-USE `\Sent`, then common names), EXAMINE it read-only, UID SEARCH HEADER
 * Message-ID, LOGOUT. It never writes, flags or deletes anything. Credentials travel only after TLS (`none` is loopback test servers only).
 */
export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly security: 'tls' | 'none';
  readonly user: string;
  readonly password?: string;
  readonly accessToken?: string;
}

export interface SentLookup {
  /** True iff the Sent folder holds a message with this Message-ID. Throws when it cannot tell (never returns false for "could not look"). */
  has(messageId: string, signal: AbortSignal): Promise<boolean>;
}

const quote = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const SENT_NAMES = ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent', '[Gmail]/Sent Mail'];

class Imap {
  private buf = '';
  private lines: string[] = [];
  private waiter: (() => void) | undefined;
  private n = 0;
  closed = false;
  constructor(private readonly sock: Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 2);
      }
      this.waiter?.();
    });
    const end = (): void => {
      this.closed = true;
      this.waiter?.();
    };
    sock.on('error', end);
    sock.on('close', end);
  }
  private async line(): Promise<string> {
    while (this.lines.length === 0) {
      if (this.closed) throw new ConnectorError('FAILED', 'imap connection lost');
      await new Promise<void>((r) => (this.waiter = r));
    }
    return this.lines.shift() as string;
  }
  async greeting(): Promise<void> {
    const l = await this.line();
    if (!/^\* (OK|PREAUTH)/i.test(l)) throw new ConnectorError('FAILED', 'imap greeting refused');
  }
  async cmd(text: string, continuation?: string): Promise<{ untagged: string[]; ok: boolean }> {
    const tag = `A${++this.n}`;
    this.sock.write(`${tag} ${text}\r\n`);
    const untagged: string[] = [];
    for (;;) {
      const l = await this.line();
      if (l.startsWith('+') && continuation !== undefined) {
        this.sock.write(`${continuation}\r\n`);
        continuation = undefined;
      } else if (l.startsWith(`${tag} `)) return { untagged, ok: /^[^ ]+ OK/i.test(l) };
      else untagged.push(l);
    }
  }
  destroy(): void {
    this.sock.destroy();
  }
}

export function imapSentLookup(cfg: ImapConfig): SentLookup {
  return {
    async has(messageId, signal) {
      if (!/^<[A-Za-z0-9._@-]{1,300}>$/.test(messageId)) throw new ConnectorError('DENIED', 'invalid message id');
      const sock: Socket = await new Promise((resolve, reject) => {
        const s =
          cfg.security === 'tls'
            ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: 'TLSv1.2' }, () => resolve(s))
            : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
        s.once('error', (e) => reject(new ConnectorError('FAILED', `imap connect failed: ${e.message}`)));
      });
      signal.addEventListener('abort', () => sock.destroy());
      // Credentials only over TLS; plain text is allowed to loopback only (local test servers), where nothing can intercept it.
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(cfg.host);
      if (cfg.security === 'none' && !loopback) {
        sock.destroy();
        throw new ConnectorError('DENIED', 'refusing to send credentials without TLS');
      }
      const imap = new Imap(sock);
      try {
        await imap.greeting();
        let auth;
        if (cfg.accessToken !== undefined) {
          const x = Buffer.from(`user=${cfg.user}\u0001auth=Bearer ${cfg.accessToken}\u0001\u0001`).toString('base64');
          auth = await imap.cmd(`AUTHENTICATE XOAUTH2 ${x}`, '');
        } else if (cfg.password !== undefined) {
          auth = await imap.cmd(`LOGIN ${quote(cfg.user)} ${quote(cfg.password)}`);
        } else throw new ConnectorError('DENIED', 'no credential for imap');
        if (!auth.ok) throw new ConnectorError('DENIED', 'imap login refused');
        // Folder: SPECIAL-USE \Sent first, then the usual names. A folder that cannot be found means we cannot look.
        const list = await imap.cmd('LIST "" "*"');
        const special = list.untagged.find((l) => /\\Sent\b/i.test(l));
        const nameOf = (l: string): string | undefined => /"?([^"]+)"?\s*$/.exec(l)?.[1];
        const names = list.untagged.map(nameOf).filter((x): x is string => x !== undefined);
        const folder = (special !== undefined ? nameOf(special) : undefined) ?? SENT_NAMES.find((n) => names.includes(n));
        if (folder === undefined) throw new ConnectorError('FAILED', 'no Sent folder found');
        if (!(await imap.cmd(`EXAMINE ${quote(folder)}`)).ok) throw new ConnectorError('FAILED', 'could not open the Sent folder');
        const found = await imap.cmd(`UID SEARCH HEADER Message-ID ${quote(messageId)}`);
        if (!found.ok) throw new ConnectorError('FAILED', 'imap search failed');
        const hit = found.untagged.find((l) => /^\* SEARCH/i.test(l));
        await imap.cmd('LOGOUT').catch(() => undefined);
        return hit !== undefined && /\d/.test(hit.slice(8));
      } finally {
        imap.destroy();
      }
    },
  };
}

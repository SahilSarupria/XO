/** Local fake providers for UW-10 tests: SMTP, IMAP and Gmail HTTP. They model the protocol subset XO uses, not any real provider. */
import { createServer as netServer, type Server, type Socket } from 'node:net';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMailbox {
  /** Message-IDs the provider holds in Sent. */
  readonly sent: Set<string>;
  readonly messages: { from: string; to: string[]; data: string }[];
}
export const newMailbox = (): FakeMailbox => ({ sent: new Set(), messages: [] });
const idOf = (data: string): string | undefined => /^Message-ID: (<[^>]+>)/im.exec(data)?.[1];

export interface FakeSmtpOptions {
  /** 1-based: after receiving the body of this message, drop the connection without replying. */
  dropAtMessage?: number;
  /** When dropping: whether the server still stored the message (so it is in Sent). */
  storeOnDrop?: boolean;
}

export async function fakeSmtp(box: FakeMailbox, opts: FakeSmtpOptions = {}): Promise<{ port: number; attempts: () => number; close: () => Promise<void> }> {
  let attempts = 0;
  const server: Server = netServer((s: Socket) => {
    s.setEncoding('utf8');
    let from = '';
    const to: string[] = [];
    let inData = false;
    let buf = '';
    s.write('220 fake ESMTP\r\n');
    s.on('error', () => undefined);
    s.on('data', (d: string) => {
      buf += d;
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          attempts++;
          if (opts.dropAtMessage === attempts) {
            if (opts.storeOnDrop === true) {
              box.messages.push({ from, to: [...to], data });
              const id = idOf(data);
              if (id) box.sent.add(id);
            }
            s.destroy();
            return;
          }
          box.messages.push({ from, to: [...to], data });
          const id = idOf(data);
          if (id) box.sent.add(id);
          s.write('250 2.0.0 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO')) s.write('250-fake\r\n250 8BITMIME\r\n');
        else if (u.startsWith('MAIL FROM')) {
          from = line.slice(10);
          to.length = 0;
          s.write('250 ok\r\n');
        } else if (u.startsWith('RCPT TO')) (to.push(line.slice(8)), s.write('250 ok\r\n'));
        else if (u === 'DATA') (inData = true, s.write('354 go\r\n'));
        else if (u === 'QUIT') (s.write('221 bye\r\n'), s.end());
        else s.write('502 no\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, attempts: () => attempts, close: () => new Promise((r) => server.close(() => r())) };
}

export async function fakeImap(box: FakeMailbox, opts: { appearAfterSearches?: number } = {}): Promise<{ port: number; searches: () => number; close: () => Promise<void> }> {
  let searches = 0;
  const server = netServer((s) => {
    s.setEncoding('utf8');
    s.on('error', () => undefined);
    s.write('* OK fake IMAP ready\r\n');
    let buf = '';
    s.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = ''] = line.split(' ');
        const c = cmd.toUpperCase();
        if (c === 'LOGIN' || c === 'AUTHENTICATE') s.write(`${tag} OK authenticated\r\n`);
        else if (c === 'LIST') s.write(`* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n${tag} OK done\r\n`);
        else if (c === 'EXAMINE') s.write(`* 0 EXISTS\r\n${tag} OK [READ-ONLY] done\r\n`);
        else if (c === 'UID') {
          searches++;
          const id = /"(<[^"]+>)"/.exec(line)?.[1];
          const visible = id !== undefined && box.sent.has(id) && searches > (opts.appearAfterSearches ?? 0);
          s.write(`* SEARCH${visible ? ' 1' : ''}\r\n${tag} OK done\r\n`);
        } else if (c === 'LOGOUT') (s.write(`* BYE\r\n${tag} OK bye\r\n`), s.end());
        else s.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, searches: () => searches, close: () => new Promise((r) => server.close(() => r())) };
}

export interface FakeGmailOptions {
  /** After this many successful sends, answer 429. */
  limitAfter?: number;
  /** Answer 500 to every send (after accepting it: the message IS stored, as a real 5xx can hide an accepted send). */
  fail500AfterStoring?: boolean;
}

export async function fakeGmail(box: FakeMailbox, opts: FakeGmailOptions = {}): Promise<{ baseUrl: string; requests: () => string[]; close: () => Promise<void> }> {
  const reqs: string[] = [];
  let ok = 0;
  const server: HttpServer = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      reqs.push(`${req.method} ${req.url}`);
      const send = (code: number, o: unknown): void => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (!/^Bearer fake-token/.test(req.headers.authorization ?? '')) return send(401, { error: 'unauthenticated' });
      if (req.method === 'POST' && req.url?.includes('/messages/send')) {
        if (opts.limitAfter !== undefined && ok >= opts.limitAfter) return send(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
        const raw = req.url.startsWith('/upload') ? body : Buffer.from((JSON.parse(body) as { raw: string }).raw, 'base64url').toString('utf8');
        box.messages.push({ from: '', to: [], data: raw });
        const id = idOf(raw);
        if (id) box.sent.add(id);
        if (opts.fail500AfterStoring === true) return send(500, { error: 'backend' });
        ok++;
        return send(200, { id: `g${ok}`, threadId: `t${ok}`, labelIds: ['SENT'] });
      }
      if (req.method === 'GET' && req.url?.startsWith('/gmail/v1/users/me/messages?')) {
        const q = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('q') ?? '');
        const id = /^rfc822msgid:(.+)$/.exec(q)?.[1];
        return send(200, id !== undefined && box.sent.has(`<${id}>`) ? { messages: [{ id: 'g1' }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => reqs, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

export async function fakeGraph(box: FakeMailbox, opts: { limitAfter?: number } = {}): Promise<{ baseUrl: string; requests: () => string[]; close: () => Promise<void> }> {
  const reqs: string[] = [];
  let ok = 0;
  const server: HttpServer = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      reqs.push(`${req.method} ${req.url}`);
      const send = (code: number, o?: unknown): void => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(o === undefined ? '' : JSON.stringify(o)));
      if (!/^Bearer fake-token/.test(req.headers.authorization ?? '')) return send(401, {});
      if (req.method === 'POST' && req.url === '/v1.0/me/sendMail') {
        if (opts.limitAfter !== undefined && ok >= opts.limitAfter) return send(429, {});
        const raw = Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64').toString('utf8');
        box.messages.push({ from: '', to: [], data: raw });
        const id = idOf(raw);
        if (id) box.sent.add(id);
        ok++;
        return send(202);
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1.0/me/messages?')) {
        const f = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('$filter') ?? '');
        const id = /internetMessageId eq '(.+)'/.exec(f)?.[1];
        return send(200, { value: id !== undefined && box.sent.has(id) ? [{ id: 'm1' }] : [] });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => reqs, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

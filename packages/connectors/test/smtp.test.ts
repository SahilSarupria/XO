import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, describe, it } from 'node:test';
import type {
  ConnectorError} from '../src/index.js';
import {
  ConnectorHost,
  MapVault,
  buildMime,
  checkRecipients,
  nodeSmtpTransport,
  smtpConnector,
  type SmtpAuth,
  type SmtpMessage,
} from '../src/index.js';

const cfg = {
  host: '127.0.0.1',
  port: 0,
  security: 'none' as const,
  from: 'desk@corp.example',
  allowedRecipientDomains: ['corp.example'],
  maxBodyBytes: 2000,
};
const manifest = {
  connectors: [
    {
      id: 'mail',
      kind: 'smtp' as const,
      operations: [{ name: 'send', sideEffect: 'write' as const, secrets: ['SMTP_USER', 'SMTP_PASSWORD'] }],
    },
  ],
};

function hostWith(
  sent: { m: SmtpMessage; a: SmtpAuth | undefined }[],
  c = { ...cfg, userSecret: 'SMTP_USER', passwordSecret: 'SMTP_PASSWORD' },
) {
  const conn = smtpConnector(c, { send: async (m, a) => void sent.push({ m, a }) });
  const host = new ConnectorHost({
    component: manifest,
    policy: { connectors: { mail: { grant: ['send'] } } },
    implementations: { mail: conn },
    vault: new MapVault({ SMTP_USER: 'mailer', SMTP_PASSWORD: 'pw-very-secret-1' }),
  });
  const send = (args: Record<string, unknown>, key = 'xo_key1') =>
    host.call({ connector: 'mail', operation: 'send', args: args as never, runId: 'r', stepId: 's', timeoutMs: 3000, idempotencyKey: key });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: ConnectorError) => e.code,
    );
  return { send, code };
}

describe('SMTP connector', () => {
  it('sends with a deterministic Message-ID derived from the idempotency key; credentials come from the vault', async () => {
    const sent: { m: SmtpMessage; a: SmtpAuth | undefined }[] = [];
    const { send } = hostWith(sent);
    await send({ to: 'ann@corp.example', subject: 'Claim c1', body: 'please review' });
    await send({ to: 'ann@corp.example', subject: 'Claim c1', body: 'please review' });
    assert.equal(sent[0]?.m.messageId, 'xo_key1');
    assert.equal(sent[0]?.m.messageId, sent[1]?.m.messageId);
    assert.deepEqual(sent[0]?.a, { user: 'mailer', password: 'pw-very-secret-1' });
  });
  it('refuses header injection, foreign domains, bad addresses, too many recipients, oversized bodies', async () => {
    const sent: { m: SmtpMessage; a: SmtpAuth | undefined }[] = [];
    const { send, code } = hostWith(sent);
    assert.equal(await code(send({ to: 'ann@corp.example', subject: 'hi\r\nBcc: evil@x.test', body: 'b' })), 'DENIED');
    assert.equal(await code(send({ to: 'ann@corp.example\r\nBcc: evil@x.test', subject: 's', body: 'b' })), 'DENIED');
    assert.equal(await code(send({ to: 'ann@evil.example', subject: 's', body: 'b' })), 'DENIED');
    assert.equal(await code(send({ to: 'not-an-address', subject: 's', body: 'b' })), 'DENIED');
    assert.equal(await code(send({ to: Array.from({ length: 9 }, (_, i) => `u${i}@corp.example`), subject: 's', body: 'b' })), 'DENIED');
    assert.equal(await code(send({ to: 'ann@corp.example', subject: 's', body: 'x'.repeat(5000) })), 'DENIED');
    assert.equal(sent.length, 0);
    assert.throws(() => checkRecipients('ann@corp.example', { allowedRecipientDomains: [] }));
  });
  it('MIME is base64 so body text cannot inject headers or terminate DATA early', () => {
    const mime = buildMime(
      { from: 'a@corp.example', to: ['b@corp.example'], subject: 'Grüße', body: 'line\r\n.\r\nBcc: x@y.z', messageId: 'id1' },
      new Date(0),
    );
    assert.ok(!mime.includes('\r\n.\r\n'));
    assert.ok(!/^Bcc:/m.test(mime));
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  });
});

describe('SMTP wire protocol (fake server on loopback)', () => {
  const servers: Server[] = [];
  after(() => void servers.forEach((s) => s.close()));
  function fakeServer(opts: { rejectRcpt?: boolean } = {}) {
    const log: string[] = [];
    let data = '';
    const s = createServer((sock) => {
      let inData = false;
      let buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 queued\r\n');
            } else data += `${line}\n`;
            continue;
          }
          log.push(line);
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 8BITMIME\r\n');
          else if (line.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
          else if (line.startsWith('RCPT TO')) sock.write(opts.rejectRcpt === true ? '550 no such user\r\n' : '250 ok\r\n');
          else if (line === 'DATA') {
            inData = true;
            sock.write('354 go\r\n');
          }
          else if (line === 'QUIT') {
            sock.write('221 bye\r\n');
            sock.end();
          }
          else sock.write('500 unknown\r\n');
        }
      });
    });
    return new Promise<{ port: number; log: string[]; data: () => string }>((r) =>
      s.listen(0, '127.0.0.1', () => (servers.push(s), r({ port: (s.address() as { port: number }).port, log, data: () => data }))),
    );
  }
  const msg: SmtpMessage = { from: 'desk@corp.example', to: ['ann@corp.example'], subject: 'hello', body: 'body text', messageId: 'abc' };
  it('speaks EHLO / MAIL / RCPT / DATA / QUIT and delivers the MIME message', async () => {
    const f = await fakeServer();
    await nodeSmtpTransport({ ...cfg, port: f.port }).send(msg, undefined, AbortSignal.timeout(5000));
    assert.deepEqual(
      f.log.map((l) => l.split(' ')[0]),
      ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT'],
    );
    assert.match(f.data(), /Message-ID: <abc@xo.invalid>/);
  });
  it('refuses to send credentials without TLS, and maps a permanent rejection to a refusal', async () => {
    const f = await fakeServer();
    await assert.rejects(
      nodeSmtpTransport({ ...cfg, port: f.port }).send(msg, { user: 'u', password: 'p' }, AbortSignal.timeout(5000)),
      (e: ConnectorError) => e.code === 'DENIED' && /without TLS/.test(e.message),
    );
    assert.ok(!f.log.some((l) => l.startsWith('AUTH')));
    const g = await fakeServer({ rejectRcpt: true });
    await assert.rejects(
      nodeSmtpTransport({ ...cfg, port: g.port }).send(msg, undefined, AbortSignal.timeout(5000)),
      (e: ConnectorError) => e.code === 'DENIED',
    );
  });
  it('STARTTLS mode refuses to continue when the server does not offer it', async () => {
    const f = await fakeServer();
    await assert.rejects(
      nodeSmtpTransport({ ...cfg, security: 'starttls', port: f.port }).send(msg, undefined, AbortSignal.timeout(5000)),
      (e: ConnectorError) => e.code === 'DENIED' && /STARTTLS/.test(e.message),
    );
  });
});

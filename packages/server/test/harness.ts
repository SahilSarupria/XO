import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXoServer, StaticTokenAuthority, newToken, type AuditEvent, type Scope, type ServerOptions } from '../src/index.js';

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Records every call that reaches a handler, so a test can prove a refused request never got that far. */
export function stubs() {
  const reached: string[] = [];
  const runner = {
    start: async () => (reached.push('runner.start'), { runId: 'r', state: 'completed', accepted: true }),
    status: async () => (reached.push('runner.status'), { state: 'completed' }),
  };
  const authority = {
    acquire: async () => (reached.push('lease.acquire'), { token: 1 }),
    heartbeat: async () => (reached.push('lease.heartbeat'), { token: 1 }),
    release: async () => void reached.push('lease.release'),
    assertCurrent: async () => void reached.push('ledger.assertCurrent'),
  };
  const replica = { ingest: async () => (reached.push('ledger.ingest'), { status: 'appended' }) };
  const store = { list: async () => [], read: async () => [] };
  return { reached, runners: { wf: runner } as never, authority: authority as never, replica: replica as never, store: store as never };
}

export interface Fixture {
  readonly port: number;
  readonly audit: AuditEvent[];
  readonly reached: string[];
  readonly tokens: Record<string, string>;
  readonly close: () => Promise<void>;
}

export const CLIENTS: { id: string; scopes: Scope[] }[] = [
  { id: 'reader', scopes: ['read'] },
  { id: 'runner', scopes: ['run'] },
  { id: 'approver', scopes: ['approve'] },
  { id: 'leaser', scopes: ['lease'] },
  { id: 'syncer', scopes: ['ledger-sync'] },
  { id: 'root', scopes: ['admin'] },
];

export async function start(over: Partial<ServerOptions> = {}, clients = CLIENTS): Promise<Fixture> {
  const s = stubs();
  const audit: AuditEvent[] = [];
  const tokens: Record<string, string> = Object.fromEntries(clients.map((c) => [c.id, newToken()]));
  const api = createXoServer({
    tokens: new StaticTokenAuthority(clients.map((c) => ({ id: c.id, token: tokens[c.id]!, scopes: c.scopes }))),
    runners: s.runners,
    store: s.store,
    authority: s.authority,
    replica: s.replica,
    audit: (e) => void audit.push(e),
    trees: new Map(),
    ...over,
  });
  const a = await api.listen();
  return { port: a.port, audit, reached: s.reached, tokens, close: api.close };
}

export function call(
  f: { port: number },
  method: string,
  path: string,
  opts: {
    token?: string;
    headers?: Record<string, string>;
    body?: string;
    tls?: { ca: string | Buffer; cert?: string | Buffer; key?: string | Buffer; servername?: string };
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const base = { host: '127.0.0.1', port: f.port, method, path, headers };
    const req =
      opts.tls !== undefined
        ? httpsRequest(
            {
              ...base,
              ca: opts.tls.ca,
              ...(opts.tls.cert !== undefined ? { cert: opts.tls.cert, key: opts.tls.key } : {}),
              servername: opts.tls.servername ?? 'localhost',
            },
            onRes,
          )
        : httpRequest(base, onRes);
    function onRes(res: IncomingMessage) {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const json = (r: Reply): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;

/** Real certificates, made at test time with the system openssl: a CA, a server cert for localhost/127.0.0.1, two client certs (one from another CA). */
export function makePki() {
  const dir = mkdtempSync(join(tmpdir(), 'xo-pki-'));
  const sh = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const ca = (name: string) => {
    sh(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.crt`,
      '-subj',
      `/CN=${name}`,
      '-days',
      '2',
    );
  };
  const leaf = (name: string, issuer: string, eku: string, san: string) => {
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=${eku}\nbasicConstraints=CA:FALSE\n`);
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    sh(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${issuer}.crt`,
      '-CAkey',
      `${issuer}.key`,
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '2',
      '-extfile',
      `${name}.ext`,
    );
  };
  ca('ca');
  ca('other-ca');
  leaf('server', 'ca', 'serverAuth', 'DNS:localhost,IP:127.0.0.1');
  leaf('client', 'ca', 'clientAuth', 'DNS:client');
  leaf('stranger', 'other-ca', 'clientAuth', 'DNS:stranger');
  const read = (f: string) => execFileSync('cat', [join(dir, f)]);
  return {
    ca: read('ca.crt'),
    serverCert: read('server.crt'),
    serverKey: read('server.key'),
    clientCert: read('client.crt'),
    clientKey: read('client.key'),
    strangerCert: read('stranger.crt'),
    strangerKey: read('stranger.key'),
  };
}

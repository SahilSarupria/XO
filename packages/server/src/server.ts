import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { createCapabilityLayer, evaluateTree, type DecisionTree } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import type { ModelFamily } from '@xo/types';
import { hasScope, requiredScope, TOKEN_FORMAT, type Scope, type TokenAuthority } from './auth.js';
import { clean, type AuditEvent, type AuditSink } from './audit.js';
import { DETERMINISTIC_HOST, negotiateWorkflows, workflowsFromLayer, type WorkflowComponent } from '@xo/workflow-ir';
import {
  ApprovalError,
  LeaseError,
  RUN_ID,
  RunInputError,
  type LeaseAuthority,
  type LedgerReplica,
  type RunStore,
  type WorkflowRunner,
} from '@xo/workflow-runtime';

export interface TlsOptions {
  /** PEM private key and certificate chain (strings or buffers). Supplied by the operator; never generated here. */
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  /** CA certificate(s) that sign the CLIENT certificates you accept. Required for `requireClientCert`. */
  readonly ca?: string | Buffer;
  /** Mutual TLS: a client without a certificate signed by `ca` cannot even complete the handshake. It is IN ADDITION to the bearer token, not instead of it. */
  readonly requireClientCert?: boolean;
}

export interface ServerOptions {
  /**
   * Per-client tokens with scopes, expiry and revocation (see auth.ts). This is how the API is meant to be exposed.
   */
  readonly tokens?: TokenAuthority;
  /**
   * LEGACY single shared secret (at least 24 characters, constant-time compared, never logged). It carries every scope except `admin`, cannot expire or be
   * revoked, and is REFUSED on any non-loopback binding. Kept for local use and development.
   */
  readonly token?: string;
  readonly host?: string;
  readonly port?: number;
  /** Required to bind anything but loopback. */
  readonly allowRemote?: boolean;
  /** Built-in TLS (TLS 1.2+). Required to bind a non-loopback address unless `behindTlsProxy` says a trusted proxy terminates TLS in front. */
  readonly tls?: TlsOptions;
  /**
   * An explicit statement that something you operate terminates TLS in front of this server and that the hop between is private. It exists so remote
   * binding without built-in TLS is a deliberate act, never an accident. Nothing here can verify it.
   */
  readonly behindTlsProxy?: boolean;
  readonly runners: Readonly<Record<string, WorkflowRunner>>;
  readonly store: RunStore;
  readonly authority: LeaseAuthority;
  readonly replica: LedgerReplica;
  readonly bundle?: PackageBundle;
  readonly trees?: ReadonlyMap<string, DecisionTree>;
  readonly maxBodyBytes?: number;
  /** Requests per minute per client address, counted before authentication. Default 240. */
  readonly rateLimitPerMinute?: number;
  /** Failed authentications per minute per address before further failures are answered 429 `AUTH_LOCKED`. Default 10. */
  readonly failedAuthLimitPerMinute?: number;
  /** Receives every refusal (never a credential). */
  readonly audit?: AuditSink;
  /** Whole-request deadline, including a slow body (default 30 000 ms), header deadline (10 000), idle keep-alive (5 000), and how often those are checked (2 000). */
  readonly requestTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly timeoutCheckIntervalMs?: number;
  readonly now?: () => number;
}

export interface HostResolution {
  readonly level: string;
  readonly consumed: readonly string[];
  readonly skipped: readonly { readonly kind: string; readonly reason: string }[];
  /** What a model-free runner can do with the package's workflows, or `{ refused: true }` when its workflows do not load. */
  readonly workflows: unknown;
  readonly receipt: ReturnType<ReturnType<typeof createCapabilityLayer>['emitLoadReceipt']>;
}

/**
 * What a host would get from a package: the level, what it consumes and skips (with reasons), and how the package's workflows negotiate on the
 * reference model-free runner. The ONE implementation behind `POST /v1/loader/resolve` and `xo flow resolve`. Loading verifies component hashes; it throws
 * on a tampered package.
 */
export function resolveForHost(
  bundle: PackageBundle,
  host: { readonly family: string; readonly capabilities: readonly string[] },
): HostResolution {
  const layer = createCapabilityLayer(bundle, { host: { family: host.family as ModelFamily, capabilities: host.capabilities as never } });
  const receipt = layer.emitLoadReceipt();
  let workflows: unknown = null;
  try {
    const wf = workflowsFromLayer(layer);
    if (wf !== undefined) workflows = negotiateWorkflows(wf.component as WorkflowComponent, DETERMINISTIC_HOST);
  } catch (e) {
    workflows = { refused: true, reason: (e as Error).message };
  }
  return { level: receipt.level, consumed: receipt.consumed, skipped: receipt.skipped, workflows, receipt };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const loopback = (h: string): boolean => h === '127.0.0.1' || h === '::1' || h === 'localhost';
const APPROVAL_ID = /^appr_[0-9a-f]{64}$/;
const WF_ID = /^[a-z][a-z0-9_]{0,63}$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,64}$/;

function legacyOk(presented: string, token: string): boolean {
  const given = Buffer.from(presented);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
  if (ct !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > max) throw new HttpError(413, 'BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) {
      req.destroy();
      throw new HttpError(413, 'BODY_TOO_LARGE');
    }
    chunks.push(c as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

const str = (v: unknown, name: string, re?: RegExp): string => {
  if (typeof v !== 'string' || (re !== undefined && !re.test(v))) throw new HttpError(400, 'BAD_REQUEST', `${name} is invalid`);
  return v;
};
const int = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, 'BAD_REQUEST', `${name} is invalid`);
  return v;
};

export function createXoServer(o: ServerOptions): {
  server: Server;
  listen: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
} {
  const host = o.host ?? '127.0.0.1';
  const local = loopback(host);
  if (o.tokens === undefined && o.token === undefined)
    throw new Error('refusing to start: no authentication configured (give `tokens`, or a legacy `token` for loopback use)');
  if (o.token !== undefined && o.token.length < 24) throw new Error('server token must be at least 24 characters');
  if (!local && o.allowRemote !== true) throw new Error(`refusing to bind ${host}: the API binds to loopback unless allowRemote is set`);
  if (!local && o.token !== undefined)
    throw new Error(
      `refusing to bind ${host} with the legacy shared token: it cannot expire, be revoked or be scoped; use per-client \`tokens\``,
    );
  if (!local && o.tls === undefined && o.behindTlsProxy !== true)
    throw new Error(
      `refusing to bind ${host} without TLS: give \`tls\`, or set \`behindTlsProxy\` to state that a TLS-terminating proxy you operate sits in front`,
    );
  if (o.tls !== undefined && o.behindTlsProxy === true) throw new Error('`tls` and `behindTlsProxy` are alternatives; set one');
  if (o.tls?.requireClientCert === true && o.tls.ca === undefined)
    throw new Error('requireClientCert needs the `ca` that signs the client certificates');
  const secure = o.tls !== undefined || o.behindTlsProxy === true;
  const audit: AuditSink = o.audit ?? (() => undefined);
  const failedLimit = o.failedAuthLimitPerMinute ?? 10;
  const failures = new Map<string, { windowStart: number; n: number }>();
  const legacyScopes = new Set<Scope>(['read', 'run', 'approve', 'lease', 'ledger-sync']);
  const maxBody = o.maxBodyBytes ?? 1_048_576;
  const now = o.now ?? Date.now;
  const buckets = new Map<string, { windowStart: number; n: number }>();
  const limit = o.rateLimitPerMinute ?? 240;
  const receipts: unknown[] = [];

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      ...(secure ? { 'strict-transport-security': 'max-age=63072000' } : {}),
      // a refused request may still be sending a body: do not keep the connection to read it
      ...(status >= 400 && status !== 404 && status !== 405 && status !== 409 && status !== 422 ? { connection: 'close' } : {}),
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const runnerFor = (id: string): WorkflowRunner => {
    const r = Object.hasOwn(o.runners, id) ? o.runners[id] : undefined;
    if (r === undefined) throw new HttpError(404, 'UNKNOWN_WORKFLOW');
    return r;
  };

  async function route(req: IncomingMessage, url: URL): Promise<{ status: number; body: unknown }> {
    const m = req.method ?? 'GET';
    const p = url.pathname.split('/').filter((x) => x !== '');
    if (p[0] !== 'v1') throw new HttpError(404, 'NOT_FOUND');
    const seg = (i: number): string => p[i] ?? '';
    const only = (...methods: string[]): void => {
      if (!methods.includes(m)) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    };

    if (p.length === 2 && p[1] === 'health') return (only('GET'), { status: 200, body: { ok: true } });
    // everything below needed auth, enforced before dispatch

    if (p[1] === 'decide' && p.length === 2) {
      only('POST');
      const b = await readJson(req, maxBody);
      const tree = o.trees?.get(str(b['treeId'], 'treeId'));
      if (tree === undefined) throw new HttpError(404, 'UNKNOWN_TREE');
      const facts = b['facts'];
      if (typeof facts !== 'object' || facts === null || Array.isArray(facts))
        throw new HttpError(400, 'BAD_REQUEST', 'facts must be an object');
      const r = evaluateTree(tree, facts as Record<string, unknown>);
      return {
        status: 200,
        body: r.ok ? { ok: true, output: r.output, rules: r.rules, trace: r.trace } : { ok: false, escalate: true, error: r.error },
      };
    }

    if (p[1] === 'workflows' && p[3] === 'runs' && p.length === 4) {
      const wfId = str(seg(2), 'workflow', WF_ID);
      const runner = runnerFor(wfId);
      if (m === 'POST') {
        const b = await readJson(req, maxBody);
        const inputs = b['inputs'];
        if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))
          throw new HttpError(400, 'BAD_REQUEST', 'inputs must be an object');
        const dk = b['dedupeKey'];
        try {
          const r = await runner.start({
            inputs: inputs as Record<string, unknown>,
            ...(typeof dk === 'string' && dk.length > 0 && dk.length <= 256 ? { dedupeKey: dk } : {}),
          });
          return { status: r.accepted ? 201 : 200, body: r };
        } catch (e) {
          if (e instanceof RunInputError) throw new HttpError(422, 'INVALID_INPUT', e.problems.join('; '));
          throw e;
        }
      }
      only('GET');
      const ids = await o.store.list();
      const out: { runId: string; state: string }[] = [];
      for (const id of ids.slice(-200))
        out.push({ runId: id, state: (await runner.status(id).catch(() => ({ state: 'unreadable' }))).state });
      return { status: 200, body: { runs: out } };
    }

    if (p[1] === 'runs' && p.length >= 3) {
      const runId = str(seg(2), 'run id', RUN_ID);
      if (p.length === 3) {
        only('GET');
        const wf = Object.values(o.runners)[0];
        if (wf === undefined) throw new HttpError(404, 'UNKNOWN_RUN');
        try {
          return { status: 200, body: await wf.status(runId) };
        } catch {
          throw new HttpError(404, 'UNKNOWN_RUN');
        }
      }
      if (p[3] === 'lease' && p.length === 4) {
        only('POST');
        const b = await readJson(req, maxBody);
        const owner = str(b['owner'], 'owner', OWNER);
        const ttl = int(b['ttlMs'], 'ttlMs', 1000, 3_600_000);
        const action = b['action'];
        if (action === 'acquire') return { status: 200, body: await o.authority.acquire(runId, owner, ttl) };
        const token = int(b['token'], 'token', 1, Number.MAX_SAFE_INTEGER);
        if (action === 'heartbeat') return { status: 200, body: await o.authority.heartbeat(runId, owner, token, ttl) };
        if (action === 'release') return (await o.authority.release(runId, owner, token), { status: 200, body: { ok: true } });
        throw new HttpError(400, 'BAD_REQUEST', 'action must be acquire, heartbeat or release');
      }
    }

    if (p[1] === 'ledger' && p.length === 3) {
      const runId = str(seg(2), 'run id', RUN_ID);
      if (m === 'GET') {
        const from = int(Number(url.searchParams.get('from') ?? '1'), 'from', 1, 1_000_000_000);
        const entries = (await o.store.read(runId)).filter((e) => e.seq >= from).slice(0, 1000);
        return { status: 200, body: { entries, tail: (await o.store.read(runId)).length } };
      }
      only('POST');
      const b = await readJson(req, maxBody);
      const owner = str(b['owner'], 'owner', OWNER);
      const token = int(b['token'], 'token', 1, Number.MAX_SAFE_INTEGER);
      await o.authority.assertCurrent(runId, owner, token); // a fenced write is refused here
      if (!Array.isArray(b['entries'])) throw new HttpError(400, 'BAD_REQUEST', 'entries must be an array');
      const r = await o.replica.ingest(runId, b['entries'] as never);
      return {
        status:
          r.status === 'appended' || r.status === 'duplicate'
            ? 200
            : r.status === 'gap'
              ? 409
              : r.status === 'fork' || r.status === 'quarantined'
                ? 409
                : 422,
        body: r,
      };
    }

    if (p[1] === 'approvals') {
      const any = Object.values(o.runners)[0];
      if (any === undefined) throw new HttpError(404, 'NOT_FOUND');
      if (p.length === 2) return (only('GET'), { status: 200, body: { approvals: await any.listApprovals() } });
      const id = str(seg(2), 'approval id', APPROVAL_ID);
      if (p.length === 3) {
        only('GET');
        const a = await any.getApproval(id);
        if (a === undefined) throw new HttpError(404, 'UNKNOWN_APPROVAL');
        return { status: 200, body: a };
      }
      if (p[3] === 'decision' && p.length === 4) {
        only('POST');
        const b = await readJson(req, maxBody);
        const runId = str(b['runId'], 'runId', RUN_ID);
        const d = b['decision'] as { payload?: { approvalId?: unknown } } | undefined;
        if (d?.payload?.approvalId !== id) throw new HttpError(400, 'BAD_REQUEST', 'decision is not for this approval');
        try {
          return { status: 200, body: await any.decideApproval(runId, d as never) };
        } catch (e) {
          if (e instanceof ApprovalError)
            throw new HttpError(e.code === 'ALREADY_DECIDED' || e.code === 'UNKNOWN_APPROVAL' ? 409 : 403, e.code, e.message);
          throw e;
        }
      }
    }

    if (p[1] === 'loader' && p[2] === 'resolve' && p.length === 3) {
      only('POST');
      if (o.bundle === undefined) throw new HttpError(404, 'NO_BUNDLE');
      const b = await readJson(req, maxBody);
      const h = b['host'] as { family?: unknown; capabilities?: unknown } | undefined;
      if (typeof h?.family !== 'string' || !Array.isArray(h.capabilities) || !h.capabilities.every((c) => typeof c === 'string'))
        throw new HttpError(400, 'BAD_REQUEST', 'host.family and host.capabilities are required');
      const resolved = resolveForHost(o.bundle, { family: h.family, capabilities: h.capabilities as string[] });
      receipts.push(resolved.receipt);
      if (receipts.length > 1000) receipts.shift();
      return { status: 200, body: resolved };
    }

    if (p[1] === 'receipts' && p.length === 2) return (only('GET'), { status: 200, body: { receipts: receipts.slice(-100) } });
    throw new HttpError(404, 'NOT_FOUND');
  }

  /** Bounded, so a flood of distinct addresses cannot grow memory without limit: the oldest entries go first. */
  const bump = (m: Map<string, { windowStart: number; n: number }>, key: string, t: number): number => {
    const cur = m.get(key);
    if (cur === undefined || t - cur.windowStart > 60_000) {
      m.delete(key);
      m.set(key, { windowStart: t, n: 1 });
      if (m.size > 10_000) m.delete(m.keys().next().value as string);
      return 1;
    }
    return ++cur.n;
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const remote = clean(req.socket.remoteAddress ?? 'unknown', 64);
      const method = req.method ?? 'GET';
      let pathname = '';
      const note = (e: Omit<AuditEvent, 'ts' | 'remote' | 'method' | 'path'>): void =>
        audit({ ts: new Date(now()).toISOString(), remote, method: clean(method, 16), path: clean(pathname), ...e });
      try {
        // only the two verbs the API uses; anything else (OPTIONS preflights, HEAD, PUT, DELETE, TRACE) is refused before authentication and before any body
        if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        const t = now();
        if (bump(buckets, remote, t) > limit) {
          pathname = req.url?.split('?')[0] ?? '';
          note({ kind: 'rate_limited' });
          throw new HttpError(429, 'RATE_LIMITED');
        }
        if ((req.url ?? '').length > 2048) throw new HttpError(414, 'URI_TOO_LONG');
        const url = new URL(req.url ?? '/', 'http://localhost');
        pathname = url.pathname;
        const need = requiredScope(method, url.pathname);
        if (need !== 'public') {
          const header = req.headers['authorization'];
          let reason: string | undefined;
          let client: { id: string; scopes: ReadonlySet<Scope> } | undefined;
          if (header === undefined) reason = 'missing';
          else if (!header.startsWith('Bearer ') || header.length > 300) reason = 'malformed';
          else {
            const presented = header.slice(7);
            const viaTokens = o.tokens !== undefined && TOKEN_FORMAT.test(presented) ? o.tokens.authenticate(presented, t) : undefined;
            if (viaTokens?.ok === true) client = viaTokens.client;
            else if (o.token !== undefined && legacyOk(presented, o.token)) client = { id: 'shared-token', scopes: legacyScopes };
            else
              reason =
                viaTokens !== undefined
                  ? viaTokens.reason
                  : o.tokens !== undefined && !TOKEN_FORMAT.test(presented) && o.token === undefined
                    ? 'malformed'
                    : 'unknown';
          }
          if (client === undefined) {
            note({ kind: reason === 'unavailable' ? 'token_store_unavailable' : 'auth_failure', reason: reason ?? 'unknown' });
            // cheap, uniform refusal; after too many failures from one address the answer changes to 429 so a guesser learns nothing more and the log is not flooded
            if (bump(failures, remote, t) > failedLimit) {
              if (failures.get(remote)?.n === failedLimit + 1) note({ kind: 'auth_lockout' });
              throw new HttpError(429, 'AUTH_LOCKED');
            }
            throw new HttpError(401, 'UNAUTHORIZED');
          }
          if (!hasScope(client.scopes, need)) {
            note({ kind: 'forbidden', clientId: client.id, need });
            throw new HttpError(
              403,
              'FORBIDDEN',
              `this token cannot ${need === 'admin' ? 'use this route' : `do this (needs scope "${need}")`}`,
            );
          }
        }
        const r = await route(req, url);
        send(res, r.status, r.body);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, ...(e.message !== e.code ? { message: e.message } : {}) });
        if (e instanceof LeaseError) return send(res, e.code === 'HELD' ? 409 : 409, { error: `LEASE_${e.code}`, message: e.message });
        send(res, 500, { error: 'INTERNAL' }); // never echo internals
      }
    })();
  };

  const timing = {
    requestTimeout: o.requestTimeoutMs ?? 30_000,
    headersTimeout: o.headersTimeoutMs ?? 10_000,
    keepAliveTimeout: o.keepAliveTimeoutMs ?? 5_000,
    connectionsCheckingInterval: o.timeoutCheckIntervalMs ?? 2_000,
    maxHeaderSize: 16_384,
  };
  const server: Server =
    o.tls !== undefined
      ? httpsServer(
          {
            key: o.tls.key,
            cert: o.tls.cert,
            ...(o.tls.ca !== undefined ? { ca: o.tls.ca } : {}),
            ...(o.tls.requireClientCert === true ? { requestCert: true, rejectUnauthorized: true } : {}),
            minVersion: 'TLSv1.2',
            ...timing,
          },
          handler,
        )
      : httpServer(timing, handler);
  server.requestTimeout = timing.requestTimeout;
  server.headersTimeout = timing.headersTimeout;
  server.keepAliveTimeout = timing.keepAliveTimeout;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.on('tlsClientError', (err, socket) => {
    audit({
      ts: new Date(now()).toISOString(),
      kind: 'tls_error',
      remote: clean(socket.remoteAddress ?? 'unknown', 64),
      method: '-',
      path: '-',
      reason: clean(String((err as NodeJS.ErrnoException).code ?? 'handshake failed'), 60),
    });
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port ?? 0, host, () => {
          const a = server.address();
          resolve({ host, port: typeof a === 'object' && a !== null ? a.port : 0 });
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

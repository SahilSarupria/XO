import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createCapabilityLayer, evaluateTree, type DecisionTree } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import type { ModelFamily } from '@xo/types';
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

export interface ServerOptions {
  /** Shared secret. At least 24 characters; compared in constant time; never logged. */
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  /** Required to bind anything but loopback. There is no TLS here: put a TLS-terminating proxy in front. */
  readonly allowRemote?: boolean;
  readonly runners: Readonly<Record<string, WorkflowRunner>>;
  readonly store: RunStore;
  readonly authority: LeaseAuthority;
  readonly replica: LedgerReplica;
  readonly bundle?: PackageBundle;
  readonly trees?: ReadonlyMap<string, DecisionTree>;
  readonly maxBodyBytes?: number;
  /** Requests per minute per client address. Default 240. */
  readonly rateLimitPerMinute?: number;
  readonly now?: () => number;
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

function bearerOk(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
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
  if (o.token.length < 24) throw new Error('server token must be at least 24 characters');
  const host = o.host ?? '127.0.0.1';
  if (!loopback(host) && o.allowRemote !== true)
    throw new Error(`refusing to bind ${host}: the API binds to loopback unless allowRemote is set (and then needs a TLS proxy)`);
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
      const layer = createCapabilityLayer(o.bundle, { host: { family: h.family as ModelFamily, capabilities: h.capabilities as never } });
      const receipt = layer.emitLoadReceipt();
      let workflows: unknown = null;
      try {
        const wf = workflowsFromLayer(layer);
        if (wf !== undefined) workflows = negotiateWorkflows(wf.component as WorkflowComponent, DETERMINISTIC_HOST);
      } catch (e) {
        workflows = { refused: true, reason: (e as Error).message };
      }
      receipts.push(receipt);
      if (receipts.length > 1000) receipts.shift();
      return { status: 200, body: { level: receipt.level, consumed: receipt.consumed, skipped: receipt.skipped, workflows, receipt } };
    }

    if (p[1] === 'receipts' && p.length === 2) return (only('GET'), { status: 200, body: { receipts: receipts.slice(-100) } });
    throw new HttpError(404, 'NOT_FOUND');
  }

  const server = httpServer((req, res) => {
    void (async () => {
      try {
        const addr = req.socket.remoteAddress ?? 'unknown';
        const t = now();
        const bkt = buckets.get(addr);
        if (bkt === undefined || t - bkt.windowStart > 60_000) buckets.set(addr, { windowStart: t, n: 1 });
        else if (++bkt.n > limit) throw new HttpError(429, 'RATE_LIMITED');
        const url = new URL(req.url ?? '/', 'http://localhost');
        const isHealth = url.pathname === '/v1/health';
        if (!isHealth && !bearerOk(req.headers['authorization'], o.token)) throw new HttpError(401, 'UNAUTHORIZED');
        const r = await route(req, url);
        send(res, r.status, r.body);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, ...(e.message !== e.code ? { message: e.message } : {}) });
        if (e instanceof LeaseError) return send(res, e.code === 'HELD' ? 409 : 409, { error: `LEASE_${e.code}`, message: e.message });
        send(res, 500, { error: 'INTERNAL' }); // never echo internals
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;

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

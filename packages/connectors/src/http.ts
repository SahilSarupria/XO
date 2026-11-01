import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from './net.js';
import { ConnectorError, type Connector, type Json } from './types.js';

export interface HttpConfig {
  /** Operator-bound origin, e.g. https://api.example.com. Workflows pass only a path; they can never choose the host. */
  readonly baseUrl: string;
  readonly methods: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  /** Path patterns: `*` matches one segment, `**` matches the rest. A path matching none is refused. */
  readonly pathPatterns: readonly string[];
  readonly maxResponseBytes: number;
  readonly maxRequestBytes?: number;
  /** Declared secret sent as `Authorization: Bearer <value>`. */
  readonly bearerSecret?: string;
  /** Only for local development against localhost. Off by default. */
  readonly allowPrivateNetwork?: boolean;
}

export interface HttpDeps {
  readonly fetch?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
}

const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((r) => r.address);

export function pathProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return 'path must start with "/"';
  if (path.length > 2048) return 'path too long';
  if (/[?#\\\u0000-\u001f]/.test(path)) return 'path contains forbidden characters (query goes in `query`)';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return 'path is not valid percent-encoding';
  }
  if (decoded.includes('//') || path.includes('//')) return 'empty path segment';
  if (decoded.split('/').some((s) => s === '..' || s === '.')) return 'path traversal';
  if (/[\\\u0000-\u001f]/.test(decoded)) return 'path contains forbidden characters';
  return undefined;
}

export function matchesPattern(path: string, pattern: string): boolean {
  const p = path.split('/').slice(1);
  const q = pattern.split('/').slice(1);
  for (let i = 0; i < q.length; i++) {
    if (q[i] === '**') return true;
    if (i >= p.length) return false;
    if (q[i] !== '*' && q[i] !== p[i]) return false;
  }
  return p.length === q.length;
}

/** Generic REST connector. Operations: `get` (read), `send` (write; POST/PUT/PATCH/DELETE). */
export function httpConnector(cfg: HttpConfig, deps: HttpDeps = {}): Connector {
  const base = new URL(cfg.baseUrl);
  if (base.protocol !== 'https:' && !(cfg.allowPrivateNetwork === true && base.protocol === 'http:'))
    throw new Error('http connector: baseUrl must be https');
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? defaultResolve;

  async function run(
    method: string,
    args: Readonly<Record<string, Json>>,
    ctx: Parameters<Connector['operations'][string]['execute']>[1],
    write: boolean,
  ): Promise<Json> {
    if (!cfg.methods.includes(method as HttpConfig['methods'][number]))
      throw new ConnectorError('DENIED', `method ${method} is not allowed`);
    const path = args['path'];
    if (typeof path !== 'string') throw new ConnectorError('DENIED', 'args.path must be a string');
    const prob = pathProblem(path);
    if (prob !== undefined) throw new ConnectorError('DENIED', `path refused: ${prob}`);
    if (!cfg.pathPatterns.some((pat) => matchesPattern(path, pat)))
      throw new ConnectorError('DENIED', `path "${path}" matches no allowed pattern`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new ConnectorError('DENIED', 'resolved origin differs from the configured origin');
    const query = args['query'];
    if (query !== undefined) {
      if (typeof query !== 'object' || query === null || Array.isArray(query))
        throw new ConnectorError('DENIED', 'args.query must be an object');
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === 'object' && v !== null) throw new ConnectorError('DENIED', `query.${k} must be a scalar`);
        url.searchParams.set(k, String(v));
      }
    }
    if (cfg.allowPrivateNetwork !== true) {
      const addrs = isIP(base.hostname) !== 0 ? [base.hostname.replace(/^\[|\]$/g, '')] : await resolve(base.hostname);
      if (addrs.length === 0 || addrs.some(isPrivateAddress))
        throw new ConnectorError('DENIED', `host ${base.hostname} resolves to a private or unresolvable address`);
    }
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.5' };
    let body: string | undefined;
    if (write && args['body'] !== undefined) {
      body = JSON.stringify(args['body']);
      if (Buffer.byteLength(body) > (cfg.maxRequestBytes ?? 1_048_576)) throw new ConnectorError('DENIED', 'request body too large');
      headers['content-type'] = 'application/json';
    }
    if (write && ctx.idempotencyKey !== undefined) headers['idempotency-key'] = ctx.idempotencyKey;
    if (cfg.bearerSecret !== undefined) headers['authorization'] = `Bearer ${ctx.secret(cfg.bearerSecret)}`;
    const res = await doFetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: ctx.signal });
    if (res.status >= 300 && res.status < 400)
      throw new ConnectorError('DENIED', `redirect (${res.status}) refused; redirects could leave the allowed origin`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > cfg.maxResponseBytes) throw new ConnectorError('DENIED', 'response exceeds maxResponseBytes');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader !== undefined)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cfg.maxResponseBytes) {
          await reader.cancel();
          throw new ConnectorError('DENIED', 'response exceeds maxResponseBytes');
        }
        chunks.push(value);
      }
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: Json = text;
    if ((res.headers.get('content-type') ?? '').includes('json'))
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        parsed = text;
      }
    if (res.status >= 500) throw new ConnectorError('FAILED', `upstream status ${res.status}`);
    return { status: res.status, ok: res.status < 400, body: parsed };
  }

  return {
    kind: 'http',
    operations: {
      get: { sideEffect: 'read', execute: (args, ctx) => run('GET', args, ctx, false) },
      send: {
        sideEffect: 'write',
        execute: (args, ctx) => {
          const method = args['method'];
          if (typeof method !== 'string' || method === 'GET')
            throw new ConnectorError('DENIED', 'args.method must be POST, PUT, PATCH or DELETE');
          return run(method, args, ctx, true);
        },
      },
    },
  };
}

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from './net.js';
import { ConnectorError } from './types.js';

/**
 * Guarded outbound HTTP for connectors whose destination an operator binds (webhooks, chat hooks).
 *
 * What it enforces, in order, and why each exists:
 *  1. scheme is https (plain http only with `allowPrivateNetwork`, for local development);
 *  2. no credentials in the URL (`https://allowed.example@evil.example/` is a classic allowlist bypass);
 *  3. the host is on the operator's allowlist: an exact name, or `*.suffix` for subdomains (never a substring match);
 *  4. the port is the scheme default unless the operator listed it;
 *  5. the name is resolved ONCE and EVERY returned address must be public (a name with one public and one private record is refused);
 *  6. the connection is then made to that vetted address, not to the name, so a second, different DNS answer cannot redirect the
 *     request (the rebinding race). TLS still verifies the certificate against the original host name;
 *  7. redirects are refused, the request and response are size-bounded, and the whole exchange honours the caller's abort signal.
 */
export interface EgressPolicy {
  /** `example.com` (exactly that host) or `*.example.com` (any subdomain, not the apex). Matched case-insensitively on the normalised host. */
  readonly allowedHosts: readonly string[];
  /** Extra ports allowed besides the scheme default. */
  readonly allowedPorts?: readonly number[];
  /** Local development only: permits http and loopback/private destinations. Off by default. */
  readonly allowPrivateNetwork?: boolean;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export interface EgressRequest {
  readonly url: string;
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The request as the transport sees it: the URL is already parsed and vetted. */
export type VettedRequest = Omit<EgressRequest, 'url'> & { readonly url: URL };

export interface EgressDeps {
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Replaceable transport (tests). It is handed the vetted address and must connect THERE. */
  readonly transport?: (req: VettedRequest, pinned: { readonly address: string }, policy: EgressPolicy) => Promise<EgressResponse>;
}

const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((r) => r.address);

export function normalizeHost(h: string): string {
  return h
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allowed.some((raw) => {
    const a = raw.toLowerCase();
    if (a.startsWith('*.')) {
      const suffix = a.slice(1); // ".example.com"
      return h.length > suffix.length && h.endsWith(suffix);
    }
    return h === a;
  });
}

/** Validates an allowlist entry at construction time: a typo must not silently widen access. */
export function allowlistProblem(entry: string): string | undefined {
  if (isIP(entry) !== 0 || /^(\*\.)?[0-9.]+$/.test(entry))
    return `"${entry}" is an IP address; allowlists are host names (an address could be re-pointed or aliased)`;
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(entry))
    return `"${entry}" is not a host name or "*.suffix" pattern (an IP address, a bare TLD and anything with a scheme, port or path are refused)`;
  return undefined;
}

export async function egress(req: EgressRequest, policy: EgressPolicy, deps: EgressDeps = {}): Promise<EgressResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ConnectorError('DENIED', 'destination is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowPrivateNetwork === true && url.protocol === 'http:'))
    throw new ConnectorError('DENIED', 'destination must be https');
  if (url.username !== '' || url.password !== '') throw new ConnectorError('DENIED', 'destination must not contain credentials');
  const host = normalizeHost(url.hostname);
  if (!hostAllowed(host, policy.allowedHosts)) throw new ConnectorError('DENIED', `host "${host}" is not on the allowlist`);
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port === '' ? defaultPort : Number(url.port);
  if (port !== defaultPort && !(policy.allowedPorts ?? []).includes(port))
    throw new ConnectorError('DENIED', `port ${port} is not allowed`);
  if (req.body !== undefined && Buffer.byteLength(req.body) > policy.maxRequestBytes)
    throw new ConnectorError('DENIED', 'request body too large');

  const resolve = deps.resolve ?? defaultResolve;
  const addrs = isIP(host) !== 0 ? [host] : await resolve(host);
  if (addrs.length === 0) throw new ConnectorError('DENIED', `host ${host} does not resolve`);
  if (policy.allowPrivateNetwork !== true && addrs.some(isPrivateAddress))
    throw new ConnectorError('DENIED', `host ${host} resolves to a private or unusable address`);
  const pinned = { address: addrs[0]! };

  const res = await (deps.transport ?? nodeTransport)({ ...req, url }, pinned, policy);
  if (res.status >= 300 && res.status < 400)
    throw new ConnectorError('DENIED', `redirect (${res.status}) refused; it could leave the allowed host`);
  return res;
}

/** Connects to the pinned address, sends the original Host, and verifies TLS against the original name. */
function nodeTransport(req: VettedRequest, pinned: { readonly address: string }, policy: EgressPolicy): Promise<EgressResponse> {
  return new Promise<EgressResponse>((resolve, reject) => {
    const secure = req.url.protocol === 'https:';
    const host = normalizeHost(req.url.hostname);
    const headers: Record<string, string> = { ...req.headers, host: req.url.host };
    if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    const send = secure ? httpsRequest : httpRequest;
    const r = send(
      {
        host: pinned.address,
        port: req.url.port === '' ? (secure ? 443 : 80) : Number(req.url.port),
        path: `${req.url.pathname}${req.url.search}`,
        method: req.method,
        headers,
        signal: req.signal,
        ...(secure && isIP(host) === 0 ? { servername: host } : {}),
      },
      (res) => {
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > policy.maxResponseBytes) {
          res.destroy();
          reject(new ConnectorError('DENIED', 'response exceeds maxResponseBytes'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > policy.maxResponseBytes) {
            res.destroy();
            reject(new ConnectorError('DENIED', 'response exceeds maxResponseBytes'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (e) => reject(new ConnectorError('FAILED', e.message)));
      },
    );
    r.on('error', (e) =>
      reject(e instanceof ConnectorError ? e : new ConnectorError(e.name === 'AbortError' ? 'TIMEOUT' : 'FAILED', e.message)),
    );
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

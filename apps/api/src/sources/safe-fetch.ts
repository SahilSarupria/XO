import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ErrorCode, XoError } from '@xo/errors';

/**
 * Server-side fetch of a user-supplied URL ("paste a link"), hardened against SSRF — the user must not be able to make
 * this server read its own loopback services, cloud metadata endpoints, or anything on the private network.
 *
 * The defenses, each load-bearing:
 *  1. https only, default port only, no credentials in the URL.
 *  2. The hostname is resolved HERE and every resolved address must be public. The connection is then made to that
 *     vetted address (TLS still verifies the original hostname via SNI) — resolving twice would let a DNS-rebinding
 *     server answer "public" to the check and "127.0.0.1" to the connection.
 *  3. Redirects are followed manually, at most `maxRedirects`, and every hop goes back through 1 and 2.
 *  4. Response size and total time are capped; the body is never buffered beyond the cap.
 * `lookup` and `transport` are injectable so tests never touch the network.
 */

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type LookupFn = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface TransportRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export type TransportFn = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchPolicy {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

export const DEFAULT_FETCH_POLICY: SafeFetchPolicy = { maxBytes: 32 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 3 };

function refuse(message: string): never {
  throw new XoError(ErrorCode.INVALID_ARGUMENT, message);
}

function upstream(message: string): never {
  throw new XoError(ErrorCode.IO_ERROR, message);
}

// ---------------------------------------------------------------- address classification

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] as number) << 24) | ((p[1] as number) << 16) | ((p[2] as number) << 8) | (p[3] as number)) >>> 0;
}

const V4_BLOCKS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return !V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

/** Expands an IPv6 literal to 8 groups of 16 bits. Returns undefined for anything malformed. */
function parseIPv6(ip: string): number[] | undefined {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return undefined;
    const v4 = ipv4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] as string).split(':')) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const groups = [...head, ...(halves.length === 2 ? Array(fill).fill('0') : []), ...rest];
  if (groups.length !== 8) return undefined;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    out.push(parseInt(g, 16));
  }
  return out;
}

export function isPublicIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (g === undefined) return false; // unparseable => not provably public => refuse
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (((g[0] as number) & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if (((g[0] as number) & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if (((g[0] as number) & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIPv4(embedded(g[6] as number, g[7] as number)); // IPv4-mapped
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return isPublicIPv4(embedded(g[6] as number, g[7] as number)); // NAT64
  if (g[0] === 0x2002) return isPublicIPv4(embedded(g[1] as number, g[2] as number)); // 6to4 embeds an IPv4
  if (g.slice(0, 6).every((x) => x === 0)) return false; // deprecated IPv4-compatible
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

// ---------------------------------------------------------------- URL validation

export function validateImportUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) refuse('"url" must be a string of at most 2048 characters');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('"url" is not a valid URL');
  }
  if (url.protocol !== 'https:') refuse('only https:// links can be imported');
  if (url.username !== '' || url.password !== '') refuse('links that embed credentials are not accepted');
  if (url.port !== '' && url.port !== '443') refuse('only the default https port is allowed');
  // A trailing dot (`localhost.`) is the same name to the resolver; strip it so the name rules below cannot be sidestepped.
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    refuse('that host name is not allowed');
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) refuse('that address is not a public internet address');
  return url;
}

// ---------------------------------------------------------------- default I/O

export const defaultLookup: LookupFn = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((f) => ({ address: f.address, family: f.family === 6 ? 6 : 4 }));
};

/**
 * The real HTTPS transport. `timeoutMs` is the IDLE limit (no bytes for that long); the whole exchange is also bounded by
 * a hard deadline of twice that, because an idle limit alone lets a server that sends one byte every few seconds hold a
 * request open forever. `requestFn` is injectable so the deadline is testable without a network.
 */
export function createHttpsTransport(requestFn: typeof httpsRequest = httpsRequest): TransportFn {
  return ({ url, address, timeoutMs, maxBytes }) =>
    new Promise((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        action();
      };
      const tooLarge = () =>
        new XoError(ErrorCode.INVALID_ARGUMENT, `the file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB import limit`);
      const req = requestFn(
        {
          host: address.address, // the vetted address — never re-resolved
          family: address.family,
          port: 443,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          servername: isIP(hostname) === 0 ? hostname : undefined,
          headers: { host: url.host, accept: '*/*', 'user-agent': 'xo-studio-import/1', 'accept-encoding': 'identity' },
          timeout: timeoutMs,
        },
        (res) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            finish(() => reject(tooLarge()));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              finish(() => reject(tooLarge()));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
            finish(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) }));
          });
          res.on('error', (e) => finish(() => reject(new XoError(ErrorCode.IO_ERROR, `download failed: ${e.message}`))));
        },
      );
      const deadline = setTimeout(() => {
        req.destroy();
        finish(() => reject(new XoError(ErrorCode.IO_ERROR, 'the download took too long')));
      }, timeoutMs * 2);
      req.on('timeout', () => {
        req.destroy();
        finish(() => reject(new XoError(ErrorCode.IO_ERROR, 'the download timed out')));
      });
      req.on('error', (e) =>
        finish(() => reject(e instanceof XoError ? e : new XoError(ErrorCode.IO_ERROR, `could not download the link: ${e.message}`))),
      );
      req.end();
    });
}

export const defaultTransport: TransportFn = createHttpsTransport();

// ---------------------------------------------------------------- the fetch

export interface FetchedDocument {
  readonly finalUrl: string;
  readonly contentType: string | undefined;
  readonly bytes: Uint8Array;
}

export async function safeFetch(
  rawUrl: string,
  deps: { readonly lookup?: LookupFn; readonly transport?: TransportFn } = {},
  policy: SafeFetchPolicy = DEFAULT_FETCH_POLICY,
): Promise<FetchedDocument> {
  const lookup = deps.lookup ?? defaultLookup;
  const transport = deps.transport ?? defaultTransport;
  let url = validateImportUrl(rawUrl);

  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly ResolvedAddress[];
    if (isIP(host) !== 0) addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    else {
      try {
        addresses = await lookup(host);
      } catch {
        return upstream(`could not resolve "${host}"`);
      }
    }
    if (addresses.length === 0) return upstream(`could not resolve "${host}"`);
    // Refuse if ANY answer is non-public: a mixed answer is how rebinding/split-horizon tricks hide a private target.
    if (!addresses.every((a) => isPublicAddress(a.address))) refuse('that link resolves to a non-public address and cannot be imported');

    const res = await transport({ url, address: addresses[0] as ResolvedAddress, timeoutMs: policy.timeoutMs, maxBytes: policy.maxBytes });
    if (res.status >= 300 && res.status < 400 && res.headers['location'] !== undefined) {
      if (hop === policy.maxRedirects) refuse('too many redirects');
      let next: string;
      try {
        next = new URL(res.headers['location'] as string, url).toString();
      } catch {
        return refuse('the link redirected to an invalid address');
      }
      url = validateImportUrl(next); // every hop re-enters the same checks (https-only, public-only)
      continue;
    }
    if (res.status !== 200) upstream(`the link returned HTTP ${res.status}`);
    if (res.body.length === 0) refuse('the link returned an empty file');
    if (res.body.length > policy.maxBytes)
      refuse(`the file is larger than the ${Math.round(policy.maxBytes / 1024 / 1024)} MB import limit`);
    return { finalUrl: url.toString(), contentType: res.headers['content-type'], bytes: res.body };
  }
  return refuse('too many redirects');
}

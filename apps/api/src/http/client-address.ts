import { isIP } from 'node:net';
import { ErrorCode, XoError } from '@xo/errors';

/**
 * The address rate limits are keyed on. By default it is the TCP peer. Behind a reverse proxy that peer is the proxy, so every
 * customer would share one bucket: set `XO_API_TRUSTED_PROXY_HOPS` to the number of proxies the operator controls in front of the
 * API, and the address is taken from `X-Forwarded-For` that many hops from the right. Entries further left are client-controlled
 * and are never trusted. A missing, short or malformed header falls back to the TCP peer, never to an attacker-chosen value.
 */
export const MAX_TRUSTED_PROXY_HOPS = 5;

export function parseTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const text = raw.trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n > MAX_TRUSTED_PROXY_HOPS)
    throw new XoError(
      ErrorCode.CONFIG_INVALID_VALUE,
      `invalid XO_API_TRUSTED_PROXY_HOPS: must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}`,
    );
  return n;
}

export function resolveClientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string | undefined {
  if (hops === 0 || peer === undefined) return peer;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (header === undefined || header.length > 2048) return peer;
  const chain = header.split(',').map((s) => s.trim());
  // chain is client, proxy1, ... proxyN-1; the TCP peer is the last proxy. With `hops` trusted proxies the client is `hops` entries from the right.
  const index = chain.length - hops;
  if (index < 0) return peer;
  const candidate = chain[index];
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : peer;
}

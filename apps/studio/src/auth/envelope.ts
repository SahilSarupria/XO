/**
 * What the native credential store holds: one opaque string, versioned and bound to the
 * sign-in method that produced it. Decoding is strict; anything unexpected is "no credential".
 * Access tokens are never persisted, only a dev key or an OIDC refresh token.
 */
export type StoredCredential =
  | { readonly kind: 'dev-key'; readonly key: string }
  | { readonly kind: 'oidc-refresh'; readonly refreshToken: string; readonly issuer: string; readonly clientId: string };

export function encodeCredential(c: StoredCredential): string {
  return JSON.stringify({ v: 1, ...c });
}

export function decodeCredential(raw: string): StoredCredential | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    // A bare string from an earlier build is a dev access key.
    return /^xoak_\S+$/.test(raw) ? { kind: 'dev-key', key: raw } : null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const s = (k: string) => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null);
  if (r['kind'] === 'dev-key') {
    const key = s('key');
    return key === null ? null : { kind: 'dev-key', key };
  }
  if (r['kind'] === 'oidc-refresh') {
    const refreshToken = s('refreshToken');
    const issuer = s('issuer');
    const clientId = s('clientId');
    return refreshToken === null || issuer === null || clientId === null ? null : { kind: 'oidc-refresh', refreshToken, issuer, clientId };
  }
  return null;
}

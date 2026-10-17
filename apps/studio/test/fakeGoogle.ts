import { webcrypto } from 'node:crypto';

/**
 * A fake Google plus a fake XO session API, enforcing what the real ones enforce for this flow: Google checks PKCE S256,
 * single-use codes, and REQUIRES the client secret at its token endpoint (observed against the real service: a request
 * without one is refused with `invalid_request: client_secret is missing.`); XO redeems the code SERVER-SIDE with that
 * secret, checks the single-use challenge, that the ID token carries that challenge's nonce, that the identity is
 * bound, rotates refresh credentials, and revokes sessions on logout. None of this is the real Google service.
 */
export class FakeGoogle {
  readonly issuer = 'https://accounts.google.test';
  tokenDown: 'none' | 'network' | '503' = 'none';
  omitIdToken = false;
  revokeFails = false;
  returnRefreshToken = true;
  /** `caller` is 'studio' unless the XO API fake made the request (it sets the x-fake-caller header). */
  calls: { url: string; body: string; caller: string }[] = [];
  /** The secret only the XO server holds. */
  static readonly SECRET = 'server-held-client-secret';
  clientRejected = false;
  revoked: string[] = [];
  lastAuth: URLSearchParams | undefined;
  private codes = new Map<string, { challenge: string; nonce: string }>();
  private n = 0;

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url: input, body, caller: new Headers(init?.headers).get('x-fake-caller') ?? 'studio' });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        revocation_endpoint: `${this.issuer}/revoke`,
        code_challenge_methods_supported: ['plain', 'S256'],
        response_types_supported: ['code'],
      });
    }
    if (url.pathname === '/revoke') {
      if (this.revokeFails) throw new TypeError('revocation unreachable');
      this.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return json({});
    }
    if (url.pathname === '/token') {
      if (this.tokenDown === 'network') throw new TypeError('Failed to fetch');
      if (this.tokenDown === '503') return json({ error: 'temporarily_unavailable' }, 503);
      const p = new URLSearchParams(body);
      if (!p.has('client_secret')) return json({ error: 'invalid_request', error_description: 'client_secret is missing.' }, 400);
      if (this.clientRejected || p.get('client_secret') !== FakeGoogle.SECRET) return json({ error: 'invalid_client' }, 401);
      const code = p.get('code') ?? '';
      const entry = this.codes.get(code);
      this.codes.delete(code);
      const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(p.get('code_verifier') ?? ''))).toString(
        'base64url',
      );
      if (entry === undefined || digest !== entry.challenge) return json({ error: 'invalid_grant' }, 400);
      return json({
        access_token: 'ya29.google-opaque-access-token',
        token_type: 'Bearer',
        expires_in: 3599,
        ...(this.returnRefreshToken ? { refresh_token: '1//google-refresh-token' } : {}),
        ...(this.omitIdToken ? {} : { id_token: `idtok.${entry.nonce}` }),
      });
    }
    return json({ error: 'nope' }, 404);
  };

  /** The fake "browser": the user authenticates at Google; returns the callback query. */
  authorize(authUrl: string, opts: { tamperState?: boolean; error?: string } = {}): string {
    const u = new URL(authUrl);
    this.lastAuth = u.searchParams;
    const state = u.searchParams.get('state') ?? '';
    if (opts.error !== undefined) return `error=${opts.error}&state=${state}`;
    const code = `gcode_${++this.n}`;
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? '', nonce: u.searchParams.get('nonce') ?? '' });
    return `code=${code}&state=${opts.tamperState === true ? 'attacker' : state}`;
  }
}

const cred = (prefix: string, n: number): string => `${prefix}${String(n).padStart(43, 'a')}`;

export class FakeXoSessions {
  /** @param google the Google this "API" redeems codes against (server-side, with the secret). Absent = not configured (501). */
  constructor(private readonly google?: FakeGoogle) {}
  bound = true;
  now = () => Date.now();
  challengeDown: 'none' | 'network' | '503' = 'none';
  refreshDown: 'none' | 'network' | '503' = 'none';
  logoutDown = false;
  calls: { path: string; body: string; authorization: string | null }[] = [];
  logouts: string[] = [];
  private challenges = new Map<string, string>();
  private access = new Map<string, { family: number; expires: number }>();
  private refresh = new Map<string, { family: number; used: boolean }>();
  private revokedFamilies = new Set<number>();
  private n = 0;
  private families = 0;

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://xo.test');
    const path = url.pathname.replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    this.calls.push({ path, body, authorization: headers.get('authorization') });
    const reply = (status: number, o?: unknown) =>
      new Response(o === undefined ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    const err = (status: number, code: string, message = 'x') => reply(status, { error: { code, message } });
    const parsed = body === '' ? {} : (JSON.parse(body) as Record<string, string>);

    if (path === '/auth/login-challenge') {
      if (this.challengeDown === 'network') throw new TypeError('Failed to fetch');
      if (this.challengeDown === '503') return err(503, 'XO_AUTH_PROVIDER_UNAVAILABLE');
      const id = `challenge-${++this.n}`;
      const nonce = `nonce-${this.n}`;
      this.challenges.set(id, nonce);
      return reply(201, { challengeId: id, nonce, expiresAt: new Date(this.now() + 300_000).toISOString() });
    }
    if (path === '/auth/session') {
      const nonce = this.challenges.get(parsed['challengeId'] ?? '');
      this.challenges.delete(parsed['challengeId'] ?? '');
      if (nonce === undefined) return err(401, 'XO_AUTH_CHALLENGE_INVALID');
      let idToken = parsed['idToken'];
      if (parsed['code'] !== undefined) {
        if (this.google === undefined) return err(501, 'XO_UNIMPLEMENTED', 'server-side code exchange is not enabled on this API');
        if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/.test(parsed['redirectUri'] ?? '')) return err(400, 'XO_INVALID_ARGUMENT');
        let res: Response;
        try {
          res = await this.google.fetch(`${this.google.issuer}/token`, {
            method: 'POST',
            headers: { 'x-fake-caller': 'xo-api' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: parsed['code'],
              redirect_uri: parsed['redirectUri'] ?? '',
              client_id: 'server-configured-client-id',
              client_secret: FakeGoogle.SECRET,
              code_verifier: parsed['codeVerifier'] ?? '',
            }).toString(),
          });
        } catch {
          return err(503, 'XO_AUTH_PROVIDER_UNAVAILABLE');
        }
        if (res.status >= 500) return err(503, 'XO_AUTH_PROVIDER_UNAVAILABLE');
        const g = (await res.json()) as { error?: string; id_token?: string; refresh_token?: string };
        if (!res.ok)
          return g.error === 'invalid_grant'
            ? err(401, 'XO_AUTH_TOKEN_INVALID', 'the sign-in code is invalid or has expired; start again')
            : err(401, 'XO_AUTH_TOKEN_INVALID', `the identity provider refused the sign-in (${g.error ?? 'error'})`);
        if (g.refresh_token !== undefined)
          void this.google
            .fetch(`${this.google.issuer}/revoke`, {
              method: 'POST',
              headers: { 'x-fake-caller': 'xo-api' },
              body: new URLSearchParams({ token: g.refresh_token }).toString(),
            })
            .catch(() => undefined);
        if (g.id_token === undefined) return err(401, 'XO_AUTH_TOKEN_INVALID', 'the identity provider returned no usable identity token');
        idToken = g.id_token;
      }
      if (idToken !== `idtok.${nonce}`) return err(401, 'XO_AUTH_TOKEN_INVALID');
      if (!this.bound) return err(401, 'XO_AUTH_IDENTITY_UNBOUND');
      return reply(201, this.issue(++this.families));
    }
    if (path === '/auth/refresh') {
      if (this.refreshDown === 'network') throw new TypeError('Failed to fetch');
      if (this.refreshDown === '503') return err(503, 'XO_AUTH_PROVIDER_UNAVAILABLE');
      const r = this.refresh.get(parsed['refreshCredential'] ?? '');
      if (r === undefined) return err(401, 'XO_AUTH_TOKEN_INVALID');
      if (r.used) {
        this.revokedFamilies.add(r.family);
        return err(401, 'XO_AUTH_TOKEN_INVALID');
      }
      r.used = true;
      if (this.revokedFamilies.has(r.family)) return err(401, 'XO_AUTH_TOKEN_INVALID');
      return reply(200, this.issue(r.family));
    }
    if (path === '/auth/logout') {
      if (this.logoutDown) throw new TypeError('Failed to fetch');
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const a = this.access.get(token);
      if (a === undefined) return err(401, 'XO_AUTH_TOKEN_INVALID');
      this.revokedFamilies.add(a.family);
      this.logouts.push(token);
      return reply(204);
    }
    if (path === '/workspaces') {
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const a = this.access.get(token);
      if (a === undefined || this.revokedFamilies.has(a.family)) return err(401, 'XO_AUTH_TOKEN_INVALID');
      if (a.expires <= this.now()) return err(401, 'XO_AUTH_TOKEN_EXPIRED');
      return reply(200, { workspaces: [] });
    }
    return err(404, 'XO_NOT_FOUND');
  };

  /** Revoke every session of the identity server-side (what a revoked binding does). */
  revokeAll(): void {
    for (let f = 1; f <= this.families; f++) this.revokedFamilies.add(f);
  }

  private issue(family: number) {
    const access = cred('xoas_', ++this.n);
    const refresh = cred('xoar_', ++this.n);
    this.access.set(access, { family, expires: this.now() + 900_000 });
    this.refresh.set(refresh, { family, used: false });
    return {
      accessCredential: access,
      accessExpiresAt: new Date(this.now() + 900_000).toISOString(),
      refreshCredential: refresh,
      refreshExpiresAt: new Date(this.now() + 30 * 86_400_000).toISOString(),
    };
  }
}

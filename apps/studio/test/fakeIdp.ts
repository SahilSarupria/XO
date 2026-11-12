import { webcrypto } from 'node:crypto';

/** A fake OIDC provider that actually enforces PKCE S256, code single-use and refresh rotation. */
export class FakeIdp {
  readonly issuer = 'https://idp.test';
  accessToken = 'xoak_good'; // FakeXo's valid bearer, so the "API" accepts what the "IdP" issues
  expiresIn = 3600;
  discoveryIssuer = this.issuer;
  discoveryExtra: Record<string, unknown> = {};
  tokenDown: 'none' | 'network' | '503' = 'none';
  refreshBehaviour: 'ok' | 'invalid_grant' = 'ok';
  rotate = true;
  calls: { url: string; body: string }[] = [];
  revoked: string[] = [];
  private challenge = new Map<string, string>(); // code -> challenge
  private refreshValid = new Set<string>();
  private n = 0;

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url: input, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: this.discoveryIssuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        revocation_endpoint: `${this.issuer}/revoke`,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
        ...this.discoveryExtra,
      });
    }
    if (url.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return json({});
    }
    if (url.pathname === '/token') {
      if (this.tokenDown === 'network') throw new TypeError('Failed to fetch');
      if (this.tokenDown === '503') return json({ error: 'temporarily_unavailable' }, 503);
      const p = new URLSearchParams(body);
      if (p.has('client_secret')) return json({ error: 'invalid_client' }, 401);
      if (p.get('grant_type') === 'authorization_code') {
        const code = p.get('code') ?? '';
        const chal = this.challenge.get(code);
        this.challenge.delete(code);
        const verifier = p.get('code_verifier') ?? '';
        const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
        if (chal === undefined || digest !== chal) return json({ error: 'invalid_grant' }, 400);
        return json(this.issue());
      }
      if (p.get('grant_type') === 'refresh_token') {
        const rt = p.get('refresh_token') ?? '';
        if (this.refreshBehaviour === 'invalid_grant' || !this.refreshValid.has(rt)) return json({ error: 'invalid_grant' }, 400);
        if (this.rotate) this.refreshValid.delete(rt);
        return json(this.issue());
      }
    }
    return json({ error: 'nope' }, 404);
  };

  private issue() {
    const rt = `rt_${++this.n}`;
    this.refreshValid.add(rt);
    return {
      access_token: this.accessToken,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      refresh_token: this.rotate ? rt : [...this.refreshValid][0],
      id_token: 'ignored.id.token',
    };
  }

  /** Called by the fake "browser": user authenticates; returns the callback query the IdP would redirect with. */
  authorize(authUrl: string, opts: { tamperState?: boolean; error?: string } = {}): string {
    const u = new URL(authUrl);
    const state = u.searchParams.get('state') ?? '';
    if (opts.error !== undefined) return `error=${opts.error}&state=${state}`;
    const code = `code_${++this.n}`;
    this.challenge.set(code, u.searchParams.get('code_challenge') ?? '');
    return `code=${code}&state=${opts.tamperState === true ? 'attacker' : state}`;
  }
  /** The refresh token a test can put in a store. */
  seedRefresh(): string {
    const rt = `rt_seed${++this.n}`;
    this.refreshValid.add(rt);
    return rt;
  }
}

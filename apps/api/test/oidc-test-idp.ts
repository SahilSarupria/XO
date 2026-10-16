import http, { type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';
import type { Logger, LogFields } from '@xo/logger';

/**
 * A real local identity provider for tests: discovery + JWKS over loopback HTTP, tokens signed with
 * freshly generated keys. No external network, no shared fixtures, no production values. Each
 * failure mode the verifier must survive is a switch on the instance.
 */
export const AUDIENCE = 'xo-api-test';

export interface SignOptions {
  sub?: string | undefined;
  iss?: string;
  aud?: string | string[];
  exp?: number | string;
  nbf?: number;
  iat?: number;
  /** Which generated key signs. Also the header kid unless `headerKid` is given. */
  kid?: string;
  headerKid?: string;
  claims?: Record<string, unknown>;
  typ?: string;
}

export class TestIdp {
  private readonly keys = new Map<string, { privateKey: CryptoKey; jwk: JWK; alg: string }>();
  private readonly unpublished = new Set<string>();
  jwksStatus = 200;
  discoveryStatus = 200;
  /** Serve this exact text as the JWKS body instead of the generated key set. */
  jwksBody: string | undefined;
  jwksRedirect = false;
  /** Serve this exact text as the discovery document instead of the generated one. */
  discoveryBody: string | undefined;
  discoveryRedirect = false;
  jwksHits = 0;
  discoveryHits = 0;
  issuer = '';
  private server!: Server;

  static async start(): Promise<TestIdp> {
    const idp = new TestIdp();
    idp.server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        idp.discoveryHits++;
        if (idp.discoveryRedirect) {
          res.statusCode = 302;
          res.setHeader('location', `${idp.issuer}/elsewhere`);
          return void res.end();
        }
        res.statusCode = idp.discoveryStatus;
        return void res.end(idp.discoveryBody ?? JSON.stringify({ issuer: idp.issuer, jwks_uri: `${idp.issuer}/jwks` }));
      }
      if (req.url === '/jwks') {
        idp.jwksHits++;
        if (idp.jwksRedirect) {
          res.statusCode = 302;
          res.setHeader('location', `${idp.issuer}/jwks-elsewhere`);
          return void res.end();
        }
        res.statusCode = idp.jwksStatus;
        const published = [...idp.keys.entries()].filter(([kid]) => !idp.unpublished.has(kid)).map(([, k]) => k.jwk);
        return void res.end(idp.jwksBody ?? JSON.stringify({ keys: published }));
      }
      if (req.url === '/jwks-elsewhere') {
        // Only reachable if a client wrongly follows a redirect; serves a VALID key set so that mistake would succeed.
        const all = [...idp.keys.values()].map((k) => k.jwk);
        return void res.end(JSON.stringify({ keys: all }));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => idp.server.listen(0, '127.0.0.1', r));
    const addr = idp.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    idp.issuer = `http://127.0.0.1:${addr.port}`;
    await idp.addKey('k1');
    return idp;
  }

  async addKey(kid: string, alg = 'RS256', publish = true): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
    this.keys.set(kid, { privateKey, jwk, alg });
    if (!publish) this.unpublished.add(kid);
  }

  publish(kid: string): void {
    this.unpublished.delete(kid);
  }

  /** The public JWK for a generated key (for algorithm-confusion tests). */
  publicJwk(kid: string): JWK {
    const k = this.keys.get(kid);
    if (k === undefined) throw new Error('unknown test key');
    return k.jwk;
  }

  async sign(opts: SignOptions = {}): Promise<string> {
    const kid = opts.kid ?? 'k1';
    const key = this.keys.get(kid);
    if (key === undefined) throw new Error('unknown test key');
    const jwt = new SignJWT({ ...(opts.claims ?? {}) })
      .setProtectedHeader({ alg: key.alg, kid: opts.headerKid ?? kid, ...(opts.typ !== undefined ? { typ: opts.typ } : {}) })
      .setIssuer(opts.iss ?? this.issuer)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt(opts.iat)
      .setExpirationTime(opts.exp ?? '5m');
    if (opts.sub !== undefined || !('sub' in opts)) jwt.setSubject(opts.sub ?? 'user-1');
    if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);
    return jwt.sign(key.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((r, j) => this.server.close((e) => (e ? j(e) : r())));
  }
}

export class CapturingLogger implements Logger {
  readonly level = 'trace' as const;
  readonly lines: string[] = [];
  private rec(m: string, f?: LogFields): void {
    this.lines.push(m + (f !== undefined ? JSON.stringify(f) : ''));
  }
  trace = (m: string, f?: LogFields): void => this.rec(m, f);
  debug = (m: string, f?: LogFields): void => this.rec(m, f);
  info = (m: string, f?: LogFields): void => this.rec(m, f);
  warn = (m: string, f?: LogFields): void => this.rec(m, f);
  error = (m: string, f?: LogFields): void => this.rec(m, f);
  fatal = (m: string, f?: LogFields): void => this.rec(m, f);
  child(): Logger {
    return this;
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { type Server } from 'node:http';
import { LocalFsBlobStore } from '@xo/storage';
import { createHttpServer, type ServerDeps } from '../src/server.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';

/** Same pattern as `packages/registry/test/test-helpers.ts#withTempStore` and `package-sdk`'s — a fresh real directory per test, cleaned up after. Used here for `?registry=`/`?store=` query params rather than a `LocalFsBlobStore` directly, since these tests exercise the HTTP layer, not the storage layer. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface TestResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly bodyText: string;
  readonly json: <T = unknown>() => T;
}

/**
 * A real `node:http` client hitting a real loopback listener — not an
 * in-process "inject" shim. This sandbox's `node:http` loopback
 * networking works even though outbound network access is blocked (see
 * README.md's "Testing" section), so there was no need to fall back to
 * the framework-inject-style testing the brief anticipated might be
 * necessary.
 *
 * Every `TestServer` provisions its own temp-dir-backed `ApiKeyStore`
 * and issues itself one active key at startup (`apiKey`/`identityId`
 * below), so `request()` can attach a valid `Authorization: Bearer`
 * header to every call by default — the ~47 pre-existing `.request(...)`
 * call sites across `registry-routes.test.ts`/`package-routes.test.ts`/
 * `runtime-routes.test.ts`/`compiler-routes.test.ts` needed zero changes
 * when real auth replaced `passThroughAuth`, since they were never
 * testing auth itself. Tests that *do* need to exercise auth failure
 * paths (`auth.test.ts`) use `skipAuth`/`extraHeaders` below to override
 * or omit the default header.
 */
export class TestServer {
  private constructor(
    private readonly server: Server,
    private readonly port: number,
    private readonly keysDir: string,
    readonly apiKeyStore: FsApiKeyStore,
    readonly apiKey: string,
    readonly identityId: string,
  ) {}

  static async start(deps: ServerDeps = {}, identityId = 'test-identity'): Promise<TestServer> {
    const keysDir = await mkdtemp(join(tmpdir(), 'xo-api-test-keys-'));
    const apiKeyStore = new FsApiKeyStore(new LocalFsBlobStore(keysDir));

    const apiKey = generateApiKey();
    const created = await apiKeyStore.create({ keyHash: hashApiKey(apiKey), identityId, createdAt: new Date().toISOString() });
    if (!created.ok) throw created.error;

    const server = createHttpServer({ apiKeyStore, ...deps });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to bind a port');
    return new TestServer(server, address.port, keysDir, apiKeyStore, apiKey, identityId);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((cause) => (cause ? reject(cause) : resolve())));
    await rm(this.keysDir, { recursive: true, force: true });
  }

  /**
   * Issues a *second*, independent identity against this same running
   * server (same `apiKeyStore`, so both keys are recognized by the one
   * listener under test) — for tests that need two distinct
   * authenticated callers (e.g. "identity A cannot read identity B's
   * workspace"). Returns a bearer key a caller can pass via
   * `request()`'s `extraHeaders` to override the server's default
   * identity for that one call.
   */
  async issueAdditionalIdentity(identityId: string): Promise<{ readonly apiKey: string; readonly identityId: string }> {
    const apiKey = generateApiKey();
    const created = await this.apiKeyStore.create({ keyHash: hashApiKey(apiKey), identityId, createdAt: new Date().toISOString() });
    if (!created.ok) throw created.error;
    return { apiKey, identityId };
  }

  /** `Authorization` header for an identity returned by `issueAdditionalIdentity` (or any other raw key) — pass as `extraHeaders` to `request()`. */
  static authHeader(apiKey: string): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${apiKey}` };
  }

  /**
   * `skipAuth: true` omits the default `Authorization` header entirely
   * (for "missing key" tests); `extraHeaders.authorization` overrides it
   * with an arbitrary value (for "malformed header"/"unknown key"/
   * "revoked key" tests) — both are opt-in, so every existing call site
   * that doesn't pass either keeps authenticating as this server's
   * default test identity, exactly as before this middleware existed.
   */
  request(method: string, path: string, body?: Buffer | unknown, extraHeaders: Readonly<Record<string, string>> = {}, opts: { readonly skipAuth?: boolean } = {}): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
      const isBuffer = Buffer.isBuffer(body);
      const data = body === undefined ? undefined : isBuffer ? body : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = { ...(opts.skipAuth === true ? {} : { authorization: `Bearer ${this.apiKey}` }), ...extraHeaders };
      if (data !== undefined) {
        headers['content-length'] = String(data.length);
        if (!isBuffer && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
      }

      const req = http.request({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText,
            json: <T>() => JSON.parse(bodyText) as T,
          });
        });
      });
      req.on('error', reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
}

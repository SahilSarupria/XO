/**
 * UW-9 (ADR 0036) — the instance side of connection credentials: the master key, the OAuth clients, the callback address, each
 * workspace's broker, and the consents waiting for their callback.
 *
 *   key       `XO_CREDENTIALS_KEY` (32 bytes, base64), a governed secret. In production nothing is generated: without it,
 *             connections are unavailable. In development one is generated once into `<data>/credentials.key` (owner-only).
 *   store     `<data>/<workspaceId>/credentials/`, sealed per workspace (see @xo/connectors CredentialStore).
 *   pending   `<data>/oauth-pending/<sha256(state)>.json`: who started which consent, for which workspace and capabilities, until
 *             when (10 minutes), with the PKCE verifier sealed. Claimed once, by an atomic rename, then deleted.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialBroker, CredentialStore, tenantKey, type CredentialEvent, type OAuthClientConfig, type OAuthDeps } from '@xo/connectors';
import { ErrorCode, XoError } from '@xo/errors';
import { SYSTEM_ACTOR } from '@xo/audit';
import type { AuditService } from '../audit/audit-service.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';

export const OAUTH_CALLBACK_PATH = '/oauth/callback';
export const PENDING_TTL_MS = 10 * 60_000;

export interface CredentialsConfig {
  readonly masterKey: Buffer;
  readonly clients: Readonly<Record<'google' | 'microsoft', OAuthClientConfig | undefined>>;
  readonly redirectUri: string;
  /** Tests: the pinned transport and resolver the provider calls go through. */
  readonly oauth?: OAuthDeps;
}

const production = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env['XO_ENV'] === 'production' || env['NODE_ENV'] === 'production';

function parseKey(b64: string): Buffer {
  const k = Buffer.from(b64.trim(), 'base64');
  if (k.length !== 32 || k.toString('base64') !== b64.trim()) throw new Error('XO_CREDENTIALS_KEY must be 32 bytes, base64-encoded');
  return k;
}

/** Reads the configuration, or `undefined` when connections are unavailable (production without a key). */
export async function loadCredentialsConfig(
  dataRootDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CredentialsConfig | undefined> {
  const configured = (env['XO_CREDENTIALS_KEY'] ?? '').trim();
  let masterKey: Buffer;
  if (configured !== '') masterKey = parseKey(configured);
  else if (production(env)) return undefined;
  else {
    const file = join(dataRootDir, 'credentials.key');
    try {
      masterKey = parseKey(await readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await mkdir(dataRootDir, { recursive: true });
      const k = randomBytes(32);
      try {
        await writeFile(file, `${k.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
        masterKey = k;
      } catch (w) {
        if ((w as NodeJS.ErrnoException).code !== 'EEXIST') throw w;
        masterKey = parseKey(await readFile(file, 'utf8')); // another process made it first
      }
      await chmod(file, 0o600).catch(() => undefined);
    }
  }
  const client = (id: string, secret: string, extra: Partial<OAuthClientConfig> = {}): OAuthClientConfig | undefined => {
    const clientId = (env[id] ?? '').trim();
    if (clientId === '') return undefined;
    const clientSecret = (env[secret] ?? '').trim();
    return { clientId, ...(clientSecret !== '' ? { clientSecret } : {}), ...extra };
  };
  const tenant = (env['XO_OAUTH_MICROSOFT_TENANT'] ?? '').trim();
  return {
    masterKey,
    clients: {
      google: client('XO_OAUTH_GOOGLE_CLIENT_ID', 'XO_OAUTH_GOOGLE_CLIENT_SECRET'),
      microsoft: client('XO_OAUTH_MICROSOFT_CLIENT_ID', 'XO_OAUTH_MICROSOFT_CLIENT_SECRET', tenant !== '' ? { tenant } : {}),
    },
    redirectUri:
      (env['XO_OAUTH_REDIRECT_URI'] ?? '').trim() || `http://127.0.0.1:${(env['PORT'] ?? '').trim() || '4000'}${OAUTH_CALLBACK_PATH}`,
  };
}

export function requireCredentials(c: CredentialsConfig | undefined): CredentialsConfig {
  if (c === undefined)
    throw new XoError(
      ErrorCode.CREDENTIALS_NOT_CONFIGURED,
      'connections are not configured on this instance: set XO_CREDENTIALS_KEY (see docs/CREDENTIALS.md)',
    );
  return c;
}

/** One workspace's broker. Its events go to the workspace's audit trail, never with a secret, an account id or a label. */
export function workspaceBroker(
  workspace: WorkspaceRecord,
  dataRootDir: string,
  c: CredentialsConfig,
  audit?: AuditService,
): CredentialBroker {
  return new CredentialBroker({
    store: new CredentialStore(join(dataRootDir, workspace.workspaceId, 'credentials'), workspace.workspaceId, c.masterKey),
    clients: c.clients,
    ...(c.oauth !== undefined ? { oauth: c.oauth } : {}),
    ...(audit !== undefined
      ? {
          // Events a person caused (connect, rotate, revoke) are recorded by the route, with that person as the actor. The
          // broker's own events (refresh, a refused refresh, a refused use) are recorded here, as the system.
          onEvent: async (e: CredentialEvent) => {
            if (e.actor !== undefined && e.actor.kind !== 'system') return;
            await audit.tryRecord({
              action: e.type,
              actor: SYSTEM_ACTOR,
              correlationId: `${e.credentialId}:${e.type}`,
              target: { kind: 'credential', id: e.credentialId, workspaceId: workspace.workspaceId },
              type: e.type,
              outcome: e.type === 'credential.use_denied' || e.type === 'credential.refresh_failed' ? 'denied' : 'completed',
              metadata: { provider: e.provider, ...(e.reason !== undefined ? { reason: e.reason.slice(0, 200) } : {}) },
            });
          },
        }
      : {}),
  });
}

// ── pending consents ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingConsent {
  readonly workspaceId: string;
  readonly startedBy: { readonly kind: string; readonly id: string };
  readonly provider: 'google' | 'microsoft';
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly expiresAt: string;
  readonly codeVerifier: string;
}

const pendingDir = (dataRootDir: string): string => join(dataRootDir, 'oauth-pending');
const pendingName = (state: string): string => createHash('sha256').update(state).digest('hex');
const pendingKey = (c: CredentialsConfig): Buffer => tenantKey(c.masterKey, '\u0000oauth-pending');

export async function savePending(dataRootDir: string, c: CredentialsConfig, state: string, p: PendingConsent): Promise<void> {
  const dir = pendingDir(dataRootDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pendingKey(c), iv);
  cipher.setAAD(Buffer.from(pendingName(state)));
  const data = Buffer.concat([cipher.update(JSON.stringify(p), 'utf8'), cipher.final()]);
  await writeFile(
    join(dir, `${pendingName(state)}.json`),
    JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }),
    { mode: 0o600, flag: 'wx' },
  );
  // Consents never completed are swept once their time is up (the file's age is enough: nothing in it is needed to decide).
  const cutoff = Date.now() - PENDING_TTL_MS - 60_000;
  for (const f of await readdir(dir)) {
    const path = join(dir, f);
    const st = await stat(path).catch(() => undefined);
    if (st !== undefined && st.mtimeMs < cutoff) await rm(path, { force: true });
  }
}

/** Claims a pending consent exactly once (rename is atomic: a replayed or concurrent callback gets nothing). */
export async function claimPending(dataRootDir: string, c: CredentialsConfig, state: string): Promise<PendingConsent | undefined> {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) return undefined;
  const dir = pendingDir(dataRootDir);
  const from = join(dir, `${pendingName(state)}.json`);
  const to = join(dir, `${pendingName(state)}.claimed.${randomBytes(6).toString('hex')}`);
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const box = JSON.parse(await readFile(to, 'utf8')) as { iv: string; tag: string; data: string };
    const d = createDecipheriv('aes-256-gcm', pendingKey(c), Buffer.from(box.iv, 'base64'));
    d.setAAD(Buffer.from(pendingName(state)));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')) as PendingConsent;
  } catch {
    return undefined;
  } finally {
    await rm(to, { force: true });
  }
}

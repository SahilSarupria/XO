// UW-12a part 2 (ADR 0039) — cloud drives through the UW-9 broker, and a folder on a person's own computer through the local agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressDeps, EgressResponse, VettedRequest } from '@xo/connectors';
import type { AgentHttp } from '@xo/connect';
import type { CredentialsConfig } from '../src/credentials/credentials.js';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import { EI_AUDIT_EXTENSION_SCHEMAS, FolderError } from '@xo/connect';
import { AuditService } from '../src/audit/audit-service.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { driveHttp } from '../src/source-connections/readers.js';
import type { WorkspaceDataConfig } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { pairCommand, runOnce } from '../../cli/src/commands/agent/index.js';
import { agentLoop } from '../../cli/src/commands/agent/loop.js';
import { TestServer, withTempDir } from './test-helpers.js';

const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const idToken = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const CSV = 'Client name,Email\nAsha Rao,asha@clientmail.in\nVenkatesh Iyengar,venkatesh@clientmail.in\n';
const PDF = (s: string) => `%PDF-1.4\n% ${s}\n%%EOF\n`;

interface Seen {
  url: string;
  auth: string | undefined;
}

/** A fake Google: OAuth, and a Drive with one folder holding a client list and a folder of certificates. */
function fakeGoogle(
  seen: Seen[],
  drive: {
    files: Record<
      string,
      { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; parent: string; body?: string }
    >;
  },
): EgressDeps {
  return {
    resolve: async () => ['142.250.80.10'],
    transport: async (req: VettedRequest): Promise<EgressResponse> => {
      seen.push({ url: req.url.toString(), auth: req.headers['authorization'] });
      const j = (status: number, body: unknown): EgressResponse => ({
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (req.url.hostname === 'oauth2.googleapis.com')
        return j(200, {
          access_token: 'ya29.DRIVE-ACCESS-SECRET',
          refresh_token: '1//REFRESH-SECRET',
          expires_in: 3599,
          token_type: 'Bearer',
          scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE}`,
          id_token: idToken({ iss: 'https://accounts.google.com', aud: 'cid.apps', sub: '1098', email: 'ops@acme.example' }),
        });
      if (req.url.hostname.endsWith('.sharepoint.com'))
        return { status: 200, headers: {}, body: '', bytes: new TextEncoder().encode('sharepoint bytes') };
      if (req.headers['authorization'] !== 'Bearer ya29.DRIVE-ACCESS-SECRET') return j(401, { error: 'unauthenticated' });
      const path = req.url.pathname;
      if (path === '/drive/v3/drives') return j(200, { drives: [] });
      if (path === '/drive/v3/files') {
        const parent = /'([^']+)' in parents/.exec(req.url.searchParams.get('q') ?? '')?.[1];
        return j(200, { files: Object.values(drive.files).filter((f) => f.parent === parent) });
      }
      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (m !== null) {
        const f =
          drive.files[m[1]!] ??
          (m[1] === 'fld1' ? { id: 'fld1', name: 'Renewals', mimeType: 'application/vnd.google-apps.folder' } : undefined);
        if (f === undefined) return j(404, {});
        if (req.url.searchParams.get('alt') === 'media') {
          const b = Buffer.from((f as { body?: string }).body ?? '');
          return { status: 200, headers: {}, body: '', bytes: new Uint8Array(b) };
        }
        return j(200, f);
      }
      return j(404, {});
    },
  };
}

async function withDrive(
  fn: (c: {
    server: TestServer;
    base: string;
    seen: Seen[];
    drive: Parameters<typeof fakeGoogle>[1];
    dataDir: string;
    credentialId: string;
    credentials: CredentialsConfig;
  }) => Promise<void>,
) {
  await withTempDir('xo-drive-', async (dataDir) => {
    const seen: Seen[] = [];
    const drive = {
      files: {
        c1: {
          id: 'c1',
          name: 'clients.csv',
          mimeType: 'text/csv',
          size: String(CSV.length),
          modifiedTime: '2026-11-16T10:00:00Z',
          parent: 'fld1',
          body: CSV,
        },
        f2: {
          id: 'f2',
          name: 'Certificates',
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: '2026-11-16T10:00:00Z',
          parent: 'fld1',
        },
        p1: {
          id: 'p1',
          name: 'Asha Rao.pdf',
          mimeType: 'application/pdf',
          size: '30',
          modifiedTime: '2026-11-16T10:00:00Z',
          parent: 'f2',
          body: PDF('asha'),
        },
        p2: {
          id: 'p2',
          name: 'Venky Iyengar.pdf',
          mimeType: 'application/pdf',
          size: '30',
          modifiedTime: '2026-11-16T10:00:00Z',
          parent: 'f2',
          body: PDF('venky'),
        },
      },
    };
    const credentials: CredentialsConfig = {
      masterKey: randomBytes(32),
      clients: { google: { clientId: 'cid.apps', clientSecret: 'client-secret' }, microsoft: undefined },
      redirectUri: 'https://xo.acme.example/oauth/callback',
      oauth: fakeGoogle(seen, drive),
    };
    const server = await TestServer.start({ workspaceDataDir: dataDir, credentials });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const base = `/workspaces/${ws}`;
      const start = await server.request('POST', `${base}/credentials/oauth`, { provider: 'google', capabilities: ['files.read'] });
      assert.equal(start.status, 201, start.bodyText);
      const body = start.json<{ authorizationUrl: string; scopes: string[] }>();
      assert.deepEqual(body.scopes, ['openid', 'email', DRIVE], 'read-only Drive access, nothing else');
      const state = new URL(body.authorizationUrl).searchParams.get('state')!;
      const cb = await server.request('GET', `/oauth/callback?state=${state}&code=4%2Fabc`, undefined, { authorization: '' });
      assert.equal(cb.status, 200, cb.bodyText);
      const credentialId = (await server.request('GET', `${base}/credentials`)).json<{ credentials: { credentialId: string }[] }>()
        .credentials[0]!.credentialId;
      await fn({ server, base, seen, drive, dataDir, credentialId, credentials });
    } finally {
      await server.stop();
    }
  });
}

test('Google Drive: choose a folder, sync it through the broker, discover roles; the token never leaves the request header', async () => {
  await withDrive(async ({ server, base, seen, drive, credentialId }) => {
    // What a client may offer here: Google is set up, Microsoft is not, no local folders, and no public address for an agent.
    const options = await server.request('GET', `${base}/source-connections/options`);
    assert.equal(options.status, 200, options.bodyText);
    assert.deepEqual(options.json(), {
      localFolder: { available: false },
      drives: [
        {
          provider: 'microsoft',
          kind: 'microsoft_drive',
          displayName: 'OneDrive or SharePoint',
          available: false,
          reason: 'provider_not_configured',
        },
        { provider: 'google', kind: 'google_drive', displayName: 'Google Drive', available: true },
      ],
      agent: { available: true },
    });
    const browse = await server.request('GET', `${base}/source-connections/drive-folders?provider=google&credentialId=${credentialId}`);
    assert.equal(browse.status, 200, browse.bodyText);
    assert.equal(browse.json<{ folders: { ref: string }[] }>().folders[0]?.ref, 'root');
    const res = await server.request('POST', `${base}/source-connections`, { kind: 'google_drive', credentialId, folder: 'fld1' });
    assert.equal(res.status, 201, res.bodyText);
    assert.ok(!res.bodyText.includes('SECRET'));
    const c = res.json<{
      connection: {
        connectionId: string;
        displayName: string;
        items: { key: string }[];
        proposals: { role: string; basis: string[] }[];
        lastSync: { added: number };
      };
    }>().connection;
    assert.equal(c.displayName, 'Renewals');
    assert.equal(c.lastSync.added, 3);
    assert.deepEqual(c.items.map((i) => i.key).sort(), ['Certificates/Asha Rao.pdf', 'Certificates/Venky Iyengar.pdf', 'clients.csv']);
    const pairing = c.proposals.find((p) => p.role === 'per_person_documents');
    assert.ok(
      pairing?.basis.some((b) => b.includes('a short form of the first name')),
      'Venky matched Venkatesh, and says so',
    );
    // Every Drive call went to Google's API with the token in the header, and only there.
    const driveCalls = seen.filter((s) => s.url.includes('/drive/v3/'));
    assert.ok(
      driveCalls.length > 0 &&
        driveCalls.every((s) => s.url.startsWith('https://www.googleapis.com/drive/v3/') && s.auth === 'Bearer ya29.DRIVE-ACCESS-SECRET'),
    );
    assert.ok(!seen.some((s) => s.url.includes('SECRET')), 'never in a URL');

    // A changed file at the provider is a new version on the next sync; a file removed there is retired.
    drive.files.c1 = { ...drive.files.c1, body: `${CSV}Zoya Khan,zoya@clientmail.in\n`, size: '120', modifiedTime: '2026-11-17T10:00:00Z' };
    delete (drive.files as Record<string, unknown>)['p2'];
    const again = (await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).json<{
      connection: { lastSync: { changed: number; removed: number } };
    }>().connection;
    assert.equal(again.lastSync.changed, 1);
    assert.equal(again.lastSync.removed, 1);
  });
});

test('Google Drive refusals: a credential without files.read, another provider, a folder that is not there; a dead credential needs attention', async () => {
  await withDrive(async ({ server, base, credentialId }) => {
    assert.equal(
      (await server.request('POST', `${base}/source-connections`, { kind: 'microsoft_drive', credentialId, folder: 'a:b' })).status,
      412,
    );
    assert.equal(
      (await server.request('POST', `${base}/source-connections`, { kind: 'google_drive', credentialId, folder: 'nope' })).status,
      400,
    );
    assert.equal(
      (
        await server.request('POST', `${base}/source-connections`, {
          kind: 'google_drive',
          credentialId: 'crd_000000000000000000000000',
          folder: 'fld1',
        })
      ).status,
      412,
    );
    const c = (await server.request('POST', `${base}/source-connections`, { kind: 'google_drive', credentialId, folder: 'fld1' })).json<{
      connection: { connectionId: string };
    }>().connection;
    // Revoke the credential: the next sync fails and the connection says why.
    assert.equal((await server.request('POST', `${base}/credentials/${credentialId}/revoke`, {})).status, 200);
    const r = (await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).json<{
      connection: { freshness: { state: string; problem?: string } };
    }>().connection;
    assert.equal(r.freshness.state, 'needs_attention');
    assert.match(r.freshness.problem ?? '', /credential/);
  });
});

test('a Microsoft pre-authenticated download is fetched without the token, and only from Microsoft storage hosts', async () => {
  await withDrive(async ({ base, seen, credentialId, dataDir, credentials }) => {
    const ctx = {
      workspace: { workspaceId: base.split('/')[2]!, identityId: 'idn_x' } as WorkspaceRecord,
      dataConfig: { dataRootDir: dataDir, credentials: async () => credentials } as unknown as WorkspaceDataConfig,
      env: {},
    };
    const http = await driveHttp(ctx, credentialId, 'microsoft');
    const got = await http.getPublicBytes('https://acme-my.sharepoint.com/personal/x/download.aspx?tempauth=t', 1024);
    assert.equal(new TextDecoder().decode(got), 'sharepoint bytes');
    assert.equal(seen.at(-1)?.auth, undefined, 'no Authorization header on the pre-authenticated address');
    for (const url of ['https://evil.example/x', 'https://graph.microsoft.com/v1.0/me', 'http://acme-my.sharepoint.com/x'])
      await assert.rejects(
        http.getPublicBytes(url, 1024),
        (e: unknown) => e instanceof FolderError && e.code === 'remote_unavailable',
        url,
      );
    // The Google credential does not carry Microsoft's read scope: the broker refuses before any request is made.
    const before = seen.length;
    await assert.rejects(
      http.getJson('https://graph.microsoft.com/v1.0/me/drive/root/children'),
      (e: unknown) => e instanceof FolderError && e.code === 'credential_unusable',
    );
    assert.equal(seen.length, before);
  });
});

// ------------------------------------------------------------------------------------------------ the local agent

/** The agent's HTTP, straight to the test server. */
const agentHttp: AgentHttp = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });

async function withAgent(
  fn: (c: { server: TestServer; base: string; home: string; folder: string; dataDir: string; workspacesDir: string }) => Promise<void>,
) {
  await withTempDir('xo-agent-home-', async (home) =>
    withTempDir('xo-agent-data-', async (dataDir) =>
      withTempDir('xo-agent-ws-', async (workspacesDir) => {
        const folder = join(home, 'Renewals');
        await mkdir(join(folder, 'Certificates'), { recursive: true });
        await writeFile(join(folder, 'clients.csv'), CSV);
        await writeFile(join(folder, 'Certificates', 'Asha Rao.pdf'), PDF('asha'));
        await writeFile(join(folder, '.env'), 'SECRET=never-sent');
        // No XO_SOURCE_FOLDER_ROOTS: the instance cannot read this folder itself; only the agent on "the computer" can.
        const server = await TestServer.start({
          workspaceDataDir: dataDir,
          workspacesDir,
          env: { XO_PUBLIC_BASE_URL: 'https://xo.acme.example' },
        });
        try {
          const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
          await fn({ server, base: `/workspaces/${ws}`, home, folder, dataDir, workspacesDir });
        } finally {
          await server.stop();
        }
      }),
    ),
  );
}

test('agent: a one-time pairing code, then the agent syncs the folder from its own computer; nothing hidden is sent', async () => {
  await withAgent(async ({ server, base, home, folder }) => {
    const opts = (await server.request('GET', `${base}/source-connections/options`)).json<{
      agent: { serverAddress?: string };
      drives: { reason?: string }[];
    }>();
    assert.equal(opts.agent.serverAddress, 'https://xo.acme.example');
    assert.ok(opts.drives.every((d) => d.reason === 'connections_not_configured' || d.reason === 'provider_not_configured'));
    const made = await server.request('POST', `${base}/source-connections`, { kind: 'agent_folder' });
    assert.equal(made.status, 201, made.bodyText);
    const { connection, pairing } = made.json<{
      connection: { connectionId: string; freshness: { state: string }; agent: { paired: boolean } };
      pairing: { code: string; command: string };
    }>();
    assert.equal(connection.agent.paired, false);
    assert.equal(connection.freshness.state, 'needs_attention');
    assert.match(pairing.code, /^[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){3}$/);
    assert.match(pairing.command, /^xo agent pair --server https:\/\/xo\.acme\.example --code /);

    const config = join(home, '.xo', 'agent.json');
    const paired = await pairCommand({ server: server.baseUrl, code: pairing.code, folder, label: 'office-pc', config }, agentHttp);
    assert.equal(paired.connectionId, connection.connectionId);
    assert.equal(((await stat(config)).mode & 0o777).toString(8), '600', 'the token file is owner-only');
    // The code works once.
    await assert.rejects(
      pairCommand({ server: server.baseUrl, code: pairing.code, folder, config: join(home, 'other.json') }, agentHttp),
      /not valid/,
    );

    const run = await runOnce(config, agentHttp);
    assert.equal(run.config.lastRun?.listed, 2);
    assert.equal(run.config.lastRun?.uploaded, 2);
    const c = (await server.request('GET', `${base}/source-connections/${connection.connectionId}`)).json<{
      connection: {
        displayName: string;
        freshness: { state: string };
        items: { key: string }[];
        agent: { paired: boolean; label: string; lastSeenAt?: string };
        lastSync: { added: number; skipped: Record<string, number> };
      };
    }>().connection;
    assert.equal(c.displayName, 'Renewals');
    assert.equal(c.agent.label, 'office-pc');
    assert.ok(c.agent.lastSeenAt !== undefined);
    assert.equal(c.freshness.state, 'current');
    assert.deepEqual(
      c.items.map((i) => i.key),
      ['Certificates/Asha Rao.pdf', 'clients.csv'],
    );
    assert.equal(c.lastSync.skipped['hidden'], 1, '.env was counted on the computer and never sent');
    const sources = (await server.request('GET', `${base}/sources`)).bodyText;
    assert.ok(!sources.includes('never-sent'));

    // Unchanged: the next run uploads nothing (digests are cached on the computer and compared on the instance).
    const second = await runOnce(config, agentHttp);
    assert.equal(second.config.lastRun?.uploaded, 0);
    // A changed file and a removed one, as for any connection.
    await writeFile(join(folder, 'clients.csv'), `${CSV}Zoya Khan,zoya@clientmail.in\n`);
    await rm(join(folder, 'Certificates', 'Asha Rao.pdf'));
    const third = await runOnce(config, agentHttp);
    assert.equal(third.config.lastRun?.uploaded, 1);
    const after = (await server.request('GET', `${base}/source-connections/${connection.connectionId}`)).json<{
      connection: { lastSync: { changed: number; removed: number } };
    }>().connection;
    assert.deepEqual([after.lastSync.changed, after.lastSync.removed], [1, 1]);
  });
});

test('agent protocol refusals: wrong token, forged digest, paths outside the folder, unstaged bytes; sync-now is a request; retire and re-pair revoke the agent', async () => {
  await withAgent(async ({ server, base, home, folder }) => {
    const made = (await server.request('POST', `${base}/source-connections`, { kind: 'agent_folder' })).json<{
      connection: { connectionId: string };
      pairing: { code: string };
    }>();
    const config = join(home, 'agent.json');
    const cfg = await pairCommand({ server: server.baseUrl, code: made.pairing.code, folder, config }, agentHttp);
    const call = (
      path: string,
      init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
      token = cfg.token,
    ) =>
      fetch(`${server.baseUrl}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });

    const forged = cfg.token.slice(0, -4) + 'AAAA';
    assert.equal((await call('/agent/v1/manifest', { method: 'GET' }, forged)).status, 401);
    assert.equal((await call('/agent/v1/manifest', { method: 'GET' }, 'not-a-token')).status, 401);
    const wrongDigest = await call('/agent/v1/blob', { method: 'PUT', headers: { 'x-xo-digest': '0'.repeat(64) }, body: 'hello' });
    assert.equal(wrongDigest.status, 400);
    const snap = (items: unknown[]) =>
      call('/agent/v1/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'xo.agent/1', folderName: 'x', items, skipped: {} }),
      });
    const item = (key: string) => ({
      key,
      name: key,
      extension: '.csv',
      sizeBytes: 3,
      modifiedAt: '2026-11-16T10:00:00Z',
      digestSha256: 'a'.repeat(64),
    });
    assert.equal((await snap([item('../etc/passwd.csv')])).status, 400);
    assert.equal((await snap([item('/abs/path.csv')])).status, 400);
    assert.equal((await snap([item('.hidden/x.csv')])).status, 400);
    // Listed but never uploaded: counted as failed, nothing stored.
    const notStaged = (await (await snap([item('ghost.csv')])).json()) as {
      lastSync: { outcome: string; failed: Record<string, number>; added: number };
    };
    assert.deepEqual([notStaged.lastSync.outcome, notStaged.lastSync.failed['not_staged'], notStaged.lastSync.added], ['partial', 1, 0]);

    // Sync now: the person asks; the agent sees it in its manifest.
    const asked = await server.request('POST', `${base}/source-connections/${made.connection.connectionId}/sync`, {});
    assert.equal(asked.status, 202);
    assert.equal(((await (await call('/agent/v1/manifest', { method: 'GET' })).json()) as { syncRequested: boolean }).syncRequested, true);
    await runOnce(config, agentHttp);
    assert.equal(((await (await call('/agent/v1/manifest', { method: 'GET' })).json()) as { syncRequested: boolean }).syncRequested, false);

    // Pairing again revokes the old agent.
    const re = await server.request('POST', `${base}/source-connections/${made.connection.connectionId}/agent/pair`, {});
    assert.equal(re.status, 200, re.bodyText);
    assert.equal((await call('/agent/v1/manifest', { method: 'GET' })).status, 401);
    const cfg2 = await pairCommand(
      { server: server.baseUrl, code: re.json<{ pairing: { code: string } }>().pairing.code, folder, config },
      agentHttp,
    );
    assert.equal((await call('/agent/v1/manifest', { method: 'GET' }, cfg2.token)).status, 200);
    // Retiring stops it for good (410), and the agent says so.
    await server.request('POST', `${base}/source-connections/${made.connection.connectionId}/retire`, {});
    assert.equal((await call('/agent/v1/manifest', { method: 'GET' }, cfg2.token)).status, 410);
    await assert.rejects(runOnce(config, agentHttp), /retired/);
  });
});

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('agent loop: a change is sent within seconds, XO being unreachable is waited out, "Sync now" is picked up, retiring stops it', async () => {
  await withAgent(async ({ server, base, home, folder }) => {
    const made = (await server.request('POST', `${base}/source-connections`, { kind: 'agent_folder' })).json<{
      connection: { connectionId: string };
      pairing: { code: string };
    }>();
    const config = join(home, 'agent.json');
    await pairCommand({ server: server.baseUrl, code: made.pairing.code, folder, config }, agentHttp);
    const keys = async () =>
      (await server.request('GET', `${base}/source-connections/${made.connection.connectionId}`))
        .json<{ connection: { items: { key: string }[] } }>()
        .connection.items.map((i) => i.key);
    const logs: string[] = [];
    let down = false;
    const flaky: AgentHttp = (url, init) => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : agentHttp(url, init));
    const stop = new AbortController();
    const running = agentLoop(
      config,
      { http: flaky, log: (l) => logs.push(l) },
      { signal: stop.signal, checkMs: 200, debounceMs: 100, minGapMs: 100, firstBackoffMs: 100, maxBackoffMs: 400 },
    );
    running.catch(() => undefined);
    try {
      await until('the first sync', () => logs.some((l) => l.includes('synced (start)')));
      assert.ok(logs.some((l) => l.startsWith('watching Renewals')));
      // A new file is sent soon after it appears, without waiting for the 15-minute schedule.
      await writeFile(join(folder, 'Certificates', 'Venky Iyengar.pdf'), PDF('venky'));
      await until('the new file', async () => (await keys()).includes('Certificates/Venky Iyengar.pdf'));
      assert.ok(logs.some((l) => l.includes('synced (change)')));
      // A hidden file changing does not cause a sync.
      const before = logs.length;
      await writeFile(join(folder, '.DS_Store'), 'x');
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(logs.slice(before).filter((l) => l.includes('synced')).length, 0);
      // XO unreachable: the agent waits and tries again, and the change arrives once XO is back.
      down = true;
      await writeFile(join(folder, 'renewals.csv'), 'Client name,Email\nZoya Khan,zoya@clientmail.in\n');
      await until('a failed attempt', () => logs.some((l) => l.includes('could not sync')));
      down = false;
      await until('the change after XO is back', async () => (await keys()).includes('renewals.csv'));
      // "Sync now" in XO reaches the agent at its next check.
      assert.equal((await server.request('POST', `${base}/source-connections/${made.connection.connectionId}/sync`, {})).status, 202);
      await until('the asked-for sync', () => logs.some((l) => l.includes('synced (asked in XO)')));
      // Retiring the connection stops the agent for good.
      await server.request('POST', `${base}/source-connections/${made.connection.connectionId}/retire`, {});
      await assert.rejects(running, /retired/);
    } finally {
      stop.abort();
      await running.catch(() => undefined);
    }
  });
});

test('the scheduler leaves agent folders to their agents', async () => {
  await withAgent(async ({ server, base, dataDir, workspacesDir }) => {
    const made = (
      await server.request('POST', `${base}/source-connections`, { kind: 'agent_folder', sync: { mode: 'interval', everyMinutes: 15 } })
    ).json<{ connection: { connectionId: string } }>();
    await runDueSchedules(
      {
        workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir)),
        dataConfig: { dataRootDir: dataDir, packageTrustPolicy: PackageTrustPolicy.development() },
        permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
        audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
        env: {},
      },
      new Date(Date.now() + 60 * 60_000),
    );
    const c = (await server.request('GET', `${base}/source-connections/${made.connection.connectionId}`)).json<{
      connection: { lastSync?: unknown };
    }>().connection;
    assert.equal(c.lastSync, undefined);
  });
});

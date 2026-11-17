// UW-12a (ADR 0038) — a workspace source connection: connect a folder, sync it into workspace sources, keep it current, retire
// what changes or disappears, propose what the files are, and open a conversation with what was found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { runDueSchedules, schedulerDepsFrom } from '../src/workflow-controls/scheduler.js';
import { WorkspaceEvidenceSources } from '../src/knowledge/evidence-sources.js';
import { workspaceSourcesStore } from '../src/workspace/workspace-context.js';

const CSV =
  'Client name,Email,Policy no\nAsha Rao,asha@clientmail.in,4471102\nVikram Mehta,vikram@clientmail.in,4471108\nZoya Khan,zoya@clientmail.in,4471111\n';
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);

interface Detail {
  connectionId: string;
  displayName: string;
  revision: number;
  freshness: { state: string };
  lastSync?: {
    outcome: string;
    added: number;
    changed: number;
    unchanged: number;
    removed: number;
    failed: Record<string, number>;
    skipped: Record<string, number>;
  };
  items: { key: string; sourceId: string }[];
  retired: { key: string; sourceId: string; reason: string; replacedBy?: string }[];
  proposals: { proposalId: string; role: string; label: string; status: string; basis: string[]; changedSinceDecision?: boolean }[];
}

async function withFolder(
  fn: (c: { server: TestServer; base: string; folder: string; allowed: string; dataDir: string; workspacesDir: string }) => Promise<void>,
) {
  await withTempDir('xo-scn-files-', async (allowed) =>
    withTempDir('xo-scn-data-', async (dataDir) =>
      withTempDir('xo-scn-ws-', async (workspacesDir) => {
        const folder = join(allowed, 'Renewals');
        await mkdir(join(folder, 'Certificates'), { recursive: true });
        await writeFile(join(folder, 'clients.csv'), CSV);
        await writeFile(join(folder, 'Certificates', 'Asha_Rao_certificate.pdf'), pdf('asha'));
        await writeFile(join(folder, 'Certificates', 'vikram-mehta-certificate.pdf'), pdf('vikram'));
        await writeFile(join(folder, 'Certificates', 'ZoyaKhan certificate.pdf'), pdf('zoya'));
        await writeFile(join(folder, '.env'), 'SECRET=never-read');
        const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, env: { XO_SOURCE_FOLDER_ROOTS: allowed } });
        try {
          const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
          await fn({ server, base: `/workspaces/${ws}`, folder, allowed, dataDir, workspacesDir });
        } finally {
          await server.stop();
        }
      }),
    ),
  );
}

test('UW-12a: connecting a folder syncs it into workspace sources and proposes what the files are; the path is never returned', async () => {
  await withFolder(async ({ server, base, folder }) => {
    const res = await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder });
    assert.equal(res.status, 201, res.bodyText);
    assert.ok(!res.bodyText.includes(folder), 'the folder path is never returned');
    assert.ok(!res.bodyText.includes('never-read'));
    const c = res.json<{ connection: Detail }>().connection;
    assert.match(c.connectionId, /^scn_[0-9a-f]{24}$/);
    assert.equal(c.displayName, 'Renewals');
    assert.equal(c.freshness.state, 'current');
    assert.equal(c.lastSync?.outcome, 'complete');
    assert.equal(c.lastSync?.added, 4);
    assert.equal(c.lastSync?.skipped['hidden'], 1, '.env is counted, never read');
    assert.deepEqual(
      c.items.map((i) => i.key),
      [
        'Certificates/Asha_Rao_certificate.pdf',
        'Certificates/vikram-mehta-certificate.pdf',
        'Certificates/ZoyaKhan certificate.pdf',
        'clients.csv',
      ],
    );
    // The files are ordinary workspace sources now: same door, same records, origin says where they came from.
    const sources = (await server.request('GET', `${base}/sources`)).json<{
      sources: { sourceId: string; origin?: { kind: string; connectionId?: string; itemKey?: string }; stats?: { rows?: number } }[];
    }>().sources;
    assert.equal(sources.length, 4);
    assert.ok(sources.every((s) => s.origin?.kind === 'connection' && s.origin.connectionId === c.connectionId));
    assert.equal(sources.find((s) => s.origin?.itemKey === 'clients.csv')?.stats?.rows, 3);

    const roles = Object.fromEntries(c.proposals.map((p) => [p.role, p]));
    assert.equal(roles['contact_list']?.label, 'a client list');
    assert.equal(roles['document_collection']?.label, 'a folder of certificates');
    assert.equal(roles['per_person_documents']?.label, "each client's certificate");
    assert.ok(
      c.proposals.every((p) => p.status === 'proposed'),
      'nothing is decided for the person',
    );
    const audit = (await server.request('GET', `${base}/audit/events?event=source.synced`)).json<{ events: unknown[] }>();
    assert.equal(audit.events.length, 4);
  });
});

test('UW-12a sync: a changed file is a new version and the old one is retired; a removed file is retired; knowledge on it stops resolving', async () => {
  await withFolder(async ({ server, base, folder, dataDir }) => {
    const c = (await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder })).json<{
      connection: Detail;
    }>().connection;
    const csvBefore = c.items.find((i) => i.key === 'clients.csv')!.sourceId;
    const ashaBefore = c.items.find((i) => i.key.startsWith('Certificates/Asha'))!.sourceId;
    await writeFile(join(folder, 'clients.csv'), `${CSV}Imran Ali,imran@clientmail.in,4471120\n`);
    await rm(join(folder, 'Certificates', 'Asha_Rao_certificate.pdf'));
    await writeFile(join(folder, 'Certificates', 'notes.pdf'), Buffer.from('<html>not a pdf</html>'));
    const res = await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {});
    assert.equal(res.status, 200, res.bodyText);
    const after = res.json<{ connection: Detail }>().connection;
    assert.equal(after.lastSync?.changed, 1);
    assert.equal(after.lastSync?.removed, 1);
    assert.equal(after.lastSync?.unchanged, 2);
    assert.equal(after.lastSync?.failed['refused_at_door'], 1, 'a .pdf holding HTML is refused at the door, as for an upload');
    assert.equal(after.lastSync?.outcome, 'partial');
    assert.equal(after.freshness.state, 'needs_attention');
    const csvNow = after.items.find((i) => i.key === 'clients.csv')!.sourceId;
    assert.notEqual(csvNow, csvBefore);
    assert.deepEqual(
      after.retired.map((r) => [r.sourceId, r.reason, r.replacedBy]),
      [
        [csvBefore, 'changed', csvNow],
        [ashaBefore, 'removed', undefined],
      ],
    );
    const old = (await server.request('GET', `${base}/sources/${csvBefore}`)).json<{ retired?: { reason: string; replacedBy?: string } }>();
    assert.deepEqual(old.retired && { reason: old.retired.reason, replacedBy: old.retired.replacedBy }, {
      reason: 'changed',
      replacedBy: csvNow,
    });
    // What was learned from the old version no longer feeds execution: the evidence resolver sees it as retired.
    const record = (await server.request('GET', `${base}/sources/${csvBefore}`)).json<{ digestSha256: string; workspaceId: string }>();
    const view = await new WorkspaceEvidenceSources(
      workspaceSourcesStore({ workspaceId: record.workspaceId } as never, { dataRootDir: dataDir } as never),
    ).source(record.digestSha256);
    assert.equal(view?.retired?.reason, 'changed');
    // An unchanged folder syncs to nothing new.
    const again = (await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).json<{ connection: Detail }>()
      .connection;
    assert.equal(again.lastSync?.added, 0);
    assert.equal(again.lastSync?.changed, 0);
  });
});

test('UW-12a roles: a person confirms or rejects a proposal; the decision is kept across syncs and flagged when the files change', async () => {
  await withFolder(async ({ server, base, folder }) => {
    const c = (await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder })).json<{
      connection: Detail;
    }>().connection;
    const list = c.proposals.find((p) => p.role === 'contact_list')!;
    const table = c.proposals.find((p) => p.role === 'record_table');
    assert.equal(table, undefined);
    const decide = (pid: string, decision: string, extra: object = {}) =>
      server.request('POST', `${base}/source-connections/${c.connectionId}/proposals/${pid}/decision`, { decision, ...extra });
    assert.equal((await decide(list.proposalId, 'maybe')).status, 400);
    assert.equal((await decide('rol_0000000000000000', 'confirmed')).status, 404);
    assert.equal((await decide(list.proposalId, 'confirmed', { expectedRevision: 1 })).status, 412, 'a stale revision is refused');
    const ok = await decide(list.proposalId, 'confirmed', { expectedRevision: c.revision });
    assert.equal(ok.status, 200, ok.bodyText);
    const docs = c.proposals.find((p) => p.role === 'document_collection')!;
    await decide(docs.proposalId, 'rejected');
    await writeFile(join(folder, 'clients.csv'), `${CSV}Imran Ali,imran@clientmail.in,4471120\n`);
    const synced = (await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).json<{ connection: Detail }>()
      .connection;
    const listNow = synced.proposals.find((p) => p.proposalId === list.proposalId)!;
    assert.equal(listNow.status, 'confirmed', 'same role over the same file: the decision stands');
    assert.equal(listNow.changedSinceDecision, true, 'but the file changed since it was confirmed');
    assert.equal(synced.proposals.find((p) => p.proposalId === docs.proposalId)!.status, 'rejected');
    const decided = (await server.request('GET', `${base}/audit/events?event=source_connection.role_decided`)).json<{
      events: { result: string }[];
    }>();
    assert.deepEqual(decided.events.map((e) => e.result).sort(), ['approved', 'rejected']);
  });
});

test('UW-12a discovery: the conversation opens with what was found and asks what to do; it names files, never a cell value', async () => {
  await withFolder(async ({ server, base, folder }) => {
    await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder });
    const res = await server.request('POST', `${base}/discovery/conversation`, {});
    assert.equal(res.status, 201, res.bodyText);
    const conv = res.json<{
      conversationId: string;
      messages: { role: string; content: string; discovery?: { proposals: { role: string; status: string }[] } }[];
    }>();
    assert.match(conv.conversationId, /^cnv_[0-9a-f]{32}$/);
    const m = conv.messages[0]!;
    assert.equal(m.role, 'assistant');
    assert.match(m.content, /^I found a spreadsheet \(clients\.csv\) and a folder of certificates \(3\)\./);
    assert.match(m.content, /What would you like to do\?$/);
    assert.ok(!/asha|vikram|zoya|4471/i.test(m.content));
    assert.deepEqual(m.discovery?.proposals.map((p) => p.role).sort(), ['contact_list', 'document_collection', 'per_person_documents']);
    // It is an ordinary conversation of the caller's: it lists and reopens like any other.
    const listed = (await server.request('GET', `${base}/intelligence/conversations`)).json<{
      conversations: { conversationId: string }[];
    }>();
    assert.ok(listed.conversations.some((x) => x.conversationId === conv.conversationId));
  });
});

test('UW-12a refusals: folders outside the allowed roots, links out of them, a second connection of one folder, and no roots at all', async () => {
  await withFolder(async ({ server, base, folder, allowed }) => {
    const post = (root: string) => server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root });
    assert.equal((await post('/etc')).status, 412);
    await symlink('/etc', join(allowed, 'etc-link'));
    assert.equal((await post(join(allowed, 'etc-link'))).status, 412, 'a link is judged by where it really goes');
    assert.equal((await post('relative/folder')).status, 400);
    assert.equal((await server.request('POST', `${base}/source-connections`, { kind: 'google_drive', root: folder })).status, 400);
    assert.equal((await post(folder)).status, 201);
    assert.equal((await post(folder)).status, 409, 'one connection per folder');
  });
  await withTempDir('xo-scn-none-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, env: {} });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const r = await server.request('POST', `/workspaces/${ws}/source-connections`, { kind: 'local_folder', root: dataDir });
      assert.equal(r.status, 412);
      assert.match(r.bodyText, /XO_SOURCE_FOLDER_ROOTS/);
    } finally {
      await server.stop();
    }
  });
});

test('UW-12a: viewers can look but not connect or sync; retiring stops syncs and retires every version; files are never touched', async () => {
  await withFolder(async ({ server, base, folder }) => {
    const c = (await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder })).json<{
      connection: Detail;
    }>().connection;
    const viewer = await server.issueAdditionalIdentity('viewer-1');
    await server.request('POST', `${base}/members`, { identityId: viewer.identityId, role: 'viewer' });
    const as = { authorization: `Bearer ${viewer.apiKey}` };
    assert.equal((await server.request('GET', `${base}/source-connections`, undefined, as)).status, 200);
    assert.equal((await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {}, as)).status, 403);
    assert.equal((await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder }, as)).status, 403);

    const before = (await readdir(folder, { recursive: true })).sort();
    const retired = await server.request('POST', `${base}/source-connections/${c.connectionId}/retire`, {});
    assert.equal(retired.status, 200, retired.bodyText);
    const r = retired.json<{ connection: Detail & { retiredAt?: string } }>().connection;
    assert.equal(r.freshness.state, 'retired');
    assert.equal(r.items.length, 0);
    assert.equal(r.retired.filter((x) => x.reason === 'connection_retired').length, 4);
    assert.equal((await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).status, 412);
    assert.deepEqual((await readdir(folder, { recursive: true })).sort(), before, 'nothing in the folder changed');
    assert.equal(await readFile(join(folder, 'clients.csv'), 'utf8'), CSV);
    const listed = (await server.request('GET', `${base}/source-connections`)).json<{ connections: unknown[] }>();
    assert.equal(listed.connections.length, 0, 'retired connections are hidden unless asked for');
    // A retired folder can be connected again.
    assert.equal((await server.request('POST', `${base}/source-connections`, { kind: 'local_folder', root: folder })).status, 201);
  });
});

test('UW-12a schedule: interval connections are synced by the scheduler when due, not before; a paused one is not synced', async () => {
  await withFolder(async ({ server, base, folder, dataDir, workspacesDir, allowed }) => {
    const c = (
      await server.request('POST', `${base}/source-connections`, {
        kind: 'local_folder',
        root: folder,
        sync: { mode: 'interval', everyMinutes: 60 },
      })
    ).json<{ connection: Detail }>().connection;
    assert.equal(
      (
        await server.request('PUT', `${base}/source-connections/${c.connectionId}/schedule`, {
          sync: { mode: 'interval', everyMinutes: 5 },
        })
      ).status,
      400,
    );
    await writeFile(join(folder, 'Certificates', 'imran ali certificate.pdf'), pdf('imran'));
    const deps = {
      ...schedulerDepsFrom(workspacesDir, dataDir, {
        permissionManager: undefined as never,
        audit: { tryRecord: async () => true } as never,
        packageTrustPolicy: undefined as never,
      }),
      env: { XO_SOURCE_FOLDER_ROOTS: allowed },
    };
    await runDueSchedules(deps, new Date(Date.now() + 30 * 60_000));
    let now = (await server.request('GET', `${base}/source-connections/${c.connectionId}`)).json<{ connection: Detail }>().connection;
    assert.equal(now.lastSync?.added, 4, 'not due yet: the first sync stands');
    await runDueSchedules(deps, new Date(Date.now() + 61 * 60_000));
    now = (await server.request('GET', `${base}/source-connections/${c.connectionId}`)).json<{ connection: Detail }>().connection;
    assert.equal(now.lastSync?.added, 1, 'due: the scheduler synced the new certificate');
    const sched = (await server.request('GET', `${base}/audit/events?event=source_connection.synced`)).json<{
      events: { actor: { identityId: string } }[];
    }>();
    assert.ok(
      sched.events.some((e) => e.actor.identityId === 'source-sync'),
      'the scheduler is the recorded actor',
    );
    await server.request('POST', `${base}/source-connections/${c.connectionId}/pause`, {});
    assert.equal((await server.request('POST', `${base}/source-connections/${c.connectionId}/sync`, {})).status, 412, 'paused');
  });
});

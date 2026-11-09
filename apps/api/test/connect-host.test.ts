/**
 * The server builds Connect itself (D-6): its own PermissionManager, its own audit sink, real connector, real files, real HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonProductionAuditSink } from '@xo/audit';
import { PermissionManager, RuleBasedPolicy, parsePermissionId, type PolicyRule } from '@xo/permissions';
import { TestServer } from './test-helpers.js';

const ID = 'test-identity';
const rule = (permission: string, principalId = ID): PolicyRule => {
  const p = parsePermissionId(permission);
  if (!p.ok) throw new Error(permission);
  return { id: `${principalId}-${permission}`, effect: 'ALLOW', match: { permission: p.value.id, principalId } };
};
const GRANTS = [
  ...['filesystem.list', 'filesystem.read', 'data.read', 'data.write', 'data.delete'].map((p) => rule(p)),
  // Connect's durable state runs as this service principal and needs a single-use audit read grant to start.
  rule('audit.read', 'xo-connect'),
];
void PermissionManager;

async function withTree(fn: (t: { root: string; state: string }) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-api-connect-')));
  const root = join(base, 'docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'hello');
  try {
    await fn({ root, state: join(base, 'state') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('real host: HTTP journey through the real permission gate and the real audit sink', async () => {
  await withTree(async ({ root, state }) => {
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
    });
    try {
      const caps = await server.request('GET', '/connect/capabilities');
      assert.equal(caps.status, 200);
      // reviewKnowledge is false for an API-key (service) identity even though it holds data.write: C6 only accepts human decisions.
      assert.deepEqual(caps.json(), {
        viewSources: true,
        manageSources: true,
        readKnowledge: true,
        reviewKnowledge: false,
        advisory: true,
      });
      const c = await server.request('POST', '/connect/local-folders', { root, includeKeys: ['a.txt'] });
      assert.equal(c.status, 201);
      const id = c.json<{ source: { id: string } }>().source.id;
      const r = await server.request('POST', `/connect/sources/${id}/read`);
      assert.equal(r.status, 200);
      assert.equal(r.json<{ source: { state: string } }>().source.state, 'read_complete');
    } finally {
      await server.stop();
    }
  });
});

test('real host: no grants means the gate refuses every Connect operation', async () => {
  await withTree(async ({ root, state }) => {
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy([rule('audit.read', 'xo-connect')]),
    });
    try {
      assert.deepEqual((await server.request('GET', '/connect/capabilities')).json(), {
        viewSources: false,
        manageSources: false,
        readKnowledge: false,
        reviewKnowledge: false,
        advisory: true,
      });
      assert.equal((await server.request('GET', '/connect/sources')).status, 403);
      assert.equal((await server.request('POST', '/connect/local-folders/preview', { root })).status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('real host: capability queries and operations reach the platform audit sink', async () => {
  await withTree(async ({ root, state }) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
      auditSink: sink,
    });
    try {
      // This sink was NOT built with the EI extension schema: Connect must fail closed, not silently skip auditing.
      const caps = await server.request('GET', '/connect/capabilities');
      assert.equal(caps.status, 503);
      const pv = await server.request('POST', '/connect/local-folders/preview', { root });
      assert.notEqual(pv.status, 200, 'an operation whose audit cannot be accepted must not proceed');
    } finally {
      await server.stop();
    }
  });
});

test('real host: durable state needs its service principal to be allowed audit.read; otherwise everything fails closed', async () => {
  await withTree(async ({ state }) => {
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS.filter((g) => g.match?.principalId !== 'xo-connect')),
    });
    try {
      assert.equal((await server.request('GET', '/connect/sources')).status, 503);
      assert.equal((await server.request('GET', '/connect/capabilities')).status, 503);
    } finally {
      await server.stop();
    }
  });
});

test('real host over HTTP: read retains evidence, removal previews and removes it, files are untouched', async () => {
  await withTree(async ({ root, state }) => {
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
    });
    try {
      const c = await server.request('POST', '/connect/local-folders', { root, includeKeys: ['a.txt'] });
      const id = c.json<{ source: { id: string } }>().source.id;
      const r = await server.request('POST', `/connect/sources/${id}/read`);
      const rep = r.json<{ source: { history: { read?: { evidence: string } }[] } }>().source.history.at(-1)?.read;
      assert.equal(rep?.evidence, 'retained');
      const prev = await server.request('GET', `/connect/sources/${id}/removal`);
      assert.equal(prev.status, 200);
      assert.ok(prev.json<{ evidenceItems: number }>().evidenceItems >= 1);
      const rm = await server.request('POST', `/connect/sources/${id}/remove`);
      assert.equal(rm.status, 200);
      assert.equal(rm.json<{ sourceFilesChanged: boolean }>().sourceFilesChanged, false);
      assert.equal((await server.request('GET', `/connect/sources/${id}`)).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('real host over HTTP: knowledge routes answer from C6 (empty for free text, which the shipped deriver does not understand)', async () => {
  await withTree(async ({ root, state }) => {
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
    });
    try {
      const c = await server.request('POST', '/connect/local-folders', { root, includeKeys: ['a.txt'] });
      const id = c.json<{ source: { id: string } }>().source.id;
      const r = await server.request('POST', `/connect/sources/${id}/read`);
      const rep = r.json<{ source: { history: { read?: { notUnderstood?: number } }[] } }>().source.history.at(-1)?.read;
      assert.equal(rep?.notUnderstood, 1);
      const k = await server.request('GET', '/connect/knowledge?q=hello');
      assert.equal(k.status, 200);
      assert.equal(k.json<{ access: { completeness: string } }>().access.completeness, 'visible_scope_only');
      assert.equal((await server.request('GET', '/connect/knowledge?select=entities')).status, 200);
      assert.equal((await server.request('GET', '/connect/knowledge/review')).status, 200);
      assert.equal(
        (await server.request('GET', '/connect/dashboard')).json<{ knowledge: { availability: string } }>().knowledge.availability,
        'empty',
      );
    } finally {
      await server.stop();
    }
  });
});

test('real host over HTTP: a structured record file becomes knowledge; removing what was learned for that item takes it away', async () => {
  await withTree(async ({ root, state }) => {
    await writeFile(
      join(root, 'org.json'),
      JSON.stringify({
        schema: 'ei.org-record.v1',
        records: [
          {
            type: 'work_item',
            project: { kind: 'project', ids: { project_key: 'PRJ-2042' } },
            owner: { kind: 'person', ids: { email: 'priya.sharma@contoso.example' } },
            status: 'active',
          },
        ],
      }),
    );
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
    });
    try {
      const c = await server.request('POST', '/connect/local-folders', { root, includeKeys: ['org.json', 'a.txt'] });
      const id = c.json<{ source: { id: string } }>().source.id;
      const r = await server.request('POST', `/connect/sources/${id}/read`);
      const rep = r
        .json<{ source: { history: { read?: { assertionsAdded?: number; notUnderstood?: number } }[] } }>()
        .source.history.at(-1)?.read;
      assert.ok((rep?.assertionsAdded ?? 0) > 0);
      assert.equal(rep?.notUnderstood, 1);
      const found = await server.request('GET', '/connect/knowledge?q=PRJ-2042');
      assert.ok(found.json<{ data: { statements: unknown[] } }>().data.statements.length > 0);
      const rm = await server.request('POST', `/connect/sources/${id}/items/remove`, { keys: ['org.json'] });
      assert.equal(rm.status, 200);
      assert.equal(rm.json<{ itemsNoLongerRead: number }>().itemsNoLongerRead, 1);
      const gone = await server.request('GET', '/connect/knowledge?q=PRJ-2042');
      assert.equal(gone.json<{ data: { statements: unknown[] } }>().data.statements.length, 0);
      assert.equal((await server.request('POST', `/connect/sources/${id}/items/remove`, { keys: [] })).status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('real host: local folders are off by default, so a hosted API never lists its own disk', async () => {
  await withTree(async ({ root, state }) => {
    const server = await TestServer.start({ connectStateDir: state, permissionPolicy: new RuleBasedPolicy(GRANTS) });
    try {
      const cat = await server.request('GET', '/connect/catalog');
      const local = cat.json<{ sources: { kind: string; availability: string }[] }>().sources.find((x) => x.kind === 'local_folder');
      assert.equal(local?.availability, 'coming_soon');
      assert.equal((await server.request('POST', '/connect/local-folders/preview', { root })).status, 503);
      assert.equal((await server.request('POST', '/connect/local-folders', { root, includeKeys: ['a.txt'] })).status, 503);
      assert.equal((await server.request('GET', '/connect/dashboard')).status, 200);
    } finally {
      await server.stop();
    }
  });
});

test('real host over HTTP: review decisions need a HUMAN principal (C6); an API-key service identity is refused and nothing is decided', async () => {
  await withTree(async ({ root, state }) => {
    const rec = (title: string) =>
      JSON.stringify({
        schema: 'ei.org-record.v1',
        records: [{ type: 'directory_entry', person: { kind: 'person', ids: { email: 'priya.sharma@contoso.example' } }, title }],
      });
    await writeFile(join(root, 't1.json'), rec('Senior Finance Manager'));
    await writeFile(join(root, 't2.json'), rec('Finance Director'));
    const server = await TestServer.start({
      connectStateDir: state,
      connectLocalFolders: true,
      permissionPolicy: new RuleBasedPolicy(GRANTS),
    });
    try {
      const c = await server.request('POST', '/connect/local-folders', { root, includeKeys: ['t1.json', 't2.json'] });
      const id = c.json<{ source: { id: string } }>().source.id;
      await server.request('POST', `/connect/sources/${id}/read`);
      const conflicts = await server.request('GET', '/connect/knowledge?select=conflicts');
      const st = conflicts.json<{ data: { statements: { item: { id: string; state: string } }[] } }>().data.statements;
      assert.equal(st.length, 1);
      const r = await server.request('POST', '/connect/knowledge/review/decisions', {
        action: 'resolve_conflict',
        conflictId: st[0]?.item.id,
        winner: 'Finance Director',
      });
      assert.equal(r.status, 403, 'only a human principal may decide');
      const again = await server.request('GET', '/connect/knowledge?select=conflicts');
      assert.equal(again.json<{ data: { statements: { item: { state: string } }[] } }>().data.statements[0]?.item.state, 'open');
      assert.equal(
        (await server.request('POST', '/connect/knowledge/review/decisions', Buffer.from('nope'), { 'content-type': 'application/json' }))
          .status,
        400,
      );
    } finally {
      await server.stop();
    }
  });
});

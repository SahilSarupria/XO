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
    const server = await TestServer.start({ connectStateDir: state, permissionPolicy: new RuleBasedPolicy(GRANTS) });
    try {
      const caps = await server.request('GET', '/connect/capabilities');
      assert.equal(caps.status, 200);
      assert.deepEqual(caps.json(), { viewSources: true, manageSources: true, readKnowledge: true, reviewKnowledge: true, advisory: true });
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
    const server = await TestServer.start({ connectStateDir: state, permissionPolicy: new RuleBasedPolicy(GRANTS), auditSink: sink });
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
    const server = await TestServer.start({ connectStateDir: state, permissionPolicy: new RuleBasedPolicy(GRANTS) });
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
    const server = await TestServer.start({ connectStateDir: state, permissionPolicy: new RuleBasedPolicy(GRANTS) });
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

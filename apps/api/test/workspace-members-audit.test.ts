import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestServer } from './test-helpers.js';
import { auditExportToCsv, type AuditExportPack } from '../src/audit/export.js';
import { canonicalJson } from '../src/audit/audit-entry.js';

interface Dirs {
  readonly workspacesDir: string;
  readonly workspaceDataDir: string;
}

async function withDirs<T>(fn: (dirs: Dirs) => Promise<T>): Promise<T> {
  const workspacesDir = await mkdtemp(join(tmpdir(), 'xo-api-test-ws-'));
  const workspaceDataDir = await mkdtemp(join(tmpdir(), 'xo-api-test-wsdata-'));
  try {
    return await fn({ workspacesDir, workspaceDataDir });
  } finally {
    await rm(workspacesDir, { recursive: true, force: true });
    await rm(workspaceDataDir, { recursive: true, force: true });
  }
}

interface AuditEventWire {
  readonly seq: number;
  readonly event: string;
  readonly result: string;
  readonly actor: { readonly identityId: string; readonly role?: string };
  readonly target?: { readonly kind: string; readonly id: string };
}

async function setup(dirs: Dirs) {
  const server = await TestServer.start(dirs);
  const created = (await server.request('POST', '/workspaces', { name: 'Aastha', kind: 'team', region: 'in-mumbai' })).json<{ workspaceId: string }>();
  const ws = created.workspaceId;
  const reviewer = await server.issueAdditionalIdentity('meera-reviewer');
  const viewer = await server.issueAdditionalIdentity('rahul-viewer');
  const publisher = await server.issueAdditionalIdentity('pri-publisher');
  const outsider = await server.issueAdditionalIdentity('outsider');
  for (const [id, role, name] of [
    ['meera-reviewer', 'reviewer', 'Meera'],
    ['rahul-viewer', 'viewer', 'Rahul'],
    ['pri-publisher', 'publisher', 'Pri'],
  ] as const) {
    const res = await server.request('POST', `/workspaces/${ws}/members`, { identityId: id, role, displayName: name });
    assert.equal(res.status, 201, res.bodyText);
  }
  return { server, ws, reviewer, viewer, publisher, outsider };
}

const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

test('workspace wire carries kind, region, memberCount and the caller role', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, reviewer } = await setup(dirs);
    try {
      const owner = (await server.request('GET', `/workspaces/${ws}`)).json<Record<string, unknown>>();
      assert.equal(owner['kind'], 'team');
      assert.equal(owner['region'], 'in-mumbai');
      assert.equal(owner['regionLabel'], 'India (Mumbai)');
      assert.equal(owner['memberCount'], 4);
      assert.equal(owner['role'], 'admin');
      assert.equal(owner['members'], undefined, 'member list is not part of the workspace wire');
      const asReviewer = (await server.request('GET', `/workspaces/${ws}`, undefined, as(reviewer))).json<Record<string, unknown>>();
      assert.equal(asReviewer['role'], 'reviewer');
    } finally {
      await server.stop();
    }
  });
});

test('create rejects an unknown region and a bad kind', async () => {
  await withDirs(async (dirs) => {
    const server = await TestServer.start(dirs);
    try {
      assert.equal((await server.request('POST', '/workspaces', { region: 'mars-1' })).status, 400);
      assert.equal((await server.request('POST', '/workspaces', { kind: 'enterprise' })).status, 400);
      const regions = (await server.request('GET', '/regions')).json<{ regions: { id: string }[] }>();
      assert.ok(regions.regions.some((r) => r.id === 'in-mumbai'));
    } finally {
      await server.stop();
    }
  });
});

test('members see the workspace in their list; outsiders get 404 everywhere', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, viewer, outsider } = await setup(dirs);
    try {
      const list = (await server.request('GET', '/workspaces', undefined, as(viewer))).json<{ workspaces: { workspaceId: string }[] }>();
      assert.deepEqual(list.workspaces.map((w) => w.workspaceId), [ws]);
      assert.equal((await server.request('GET', `/workspaces/${ws}`, undefined, as(viewer))).status, 200);

      assert.equal((await server.request('GET', '/workspaces', undefined, as(outsider))).json<{ workspaces: unknown[] }>().workspaces.length, 0);
      for (const path of [`/workspaces/${ws}`, `/workspaces/${ws}/members`, `/workspaces/${ws}/audit/events`, `/workspaces/${ws}/sources`]) {
        assert.equal((await server.request('GET', path, undefined, as(outsider))).status, 404, path);
      }
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'x', role: 'admin' }, as(outsider))).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('member management: validation, duplicates, owner protection, role change, removal', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, viewer } = await setup(dirs);
    try {
      const list = (await server.request('GET', `/workspaces/${ws}/members`)).json<{ total: number; roleCounts: Record<string, number>; members: { identityId: string; isOwner: boolean }[] }>();
      assert.equal(list.total, 4);
      assert.deepEqual(list.roleCounts, { admin: 1, publisher: 1, reviewer: 1, viewer: 1 });
      assert.equal(list.members[0]?.isOwner, true);

      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'rahul-viewer', role: 'viewer' })).status, 409);
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: server.identityId, role: 'viewer' })).status, 409);
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'bad id with spaces', role: 'viewer' })).status, 400);
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'new-one', role: 'superuser' })).status, 400);

      assert.equal((await server.request('PATCH', `/workspaces/${ws}/members/${server.identityId}`, { role: 'viewer' })).status, 412);
      assert.equal((await server.request('DELETE', `/workspaces/${ws}/members/${server.identityId}`)).status, 412);
      assert.equal((await server.request('PATCH', `/workspaces/${ws}/members/ghost`, { role: 'viewer' })).status, 404);

      const changed = await server.request('PATCH', `/workspaces/${ws}/members/rahul-viewer`, { role: 'publisher' });
      assert.equal(changed.status, 200);
      assert.equal((await server.request('GET', `/workspaces/${ws}`, undefined, as(viewer))).json<{ role: string }>().role, 'publisher');

      assert.equal((await server.request('DELETE', `/workspaces/${ws}/members/rahul-viewer`)).status, 200);
      assert.equal((await server.request('GET', `/workspaces/${ws}`, undefined, as(viewer))).status, 404, 'a removed member loses access immediately');
    } finally {
      await server.stop();
    }
  });
});

test('a personal workspace cannot have members', async () => {
  await withDirs(async (dirs) => {
    const server = await TestServer.start(dirs);
    try {
      const ws = (await server.request('POST', '/workspaces', { kind: 'personal' })).json<{ workspaceId: string }>().workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'friend', role: 'viewer' })).status, 412);
    } finally {
      await server.stop();
    }
  });
});

test('roles are enforced: viewer/reviewer cannot upload or manage; denials are audited', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, viewer, reviewer, publisher } = await setup(dirs);
    try {
      const upload = (headers: Record<string, string>) =>
        server.request('POST', `/workspaces/${ws}/sources?filename=claims.txt`, Buffer.from('claims policy text'), { 'content-type': 'text/plain', ...headers });

      const denied = await upload(as(viewer));
      assert.equal(denied.status, 403);
      assert.equal((await upload(as(reviewer))).status, 403);
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'z', role: 'viewer' }, as(publisher))).status, 403);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/events`, undefined, as(viewer))).status, 403);

      const ok = await upload(as(publisher));
      assert.equal(ok.status, 201, ok.bodyText);

      const events = (await server.request('GET', `/workspaces/${ws}/audit/events?result=denied`)).json<{ events: AuditEventWire[] }>();
      const who = events.events.map((e) => `${e.actor.identityId}:${e.actor.role}`).sort();
      assert.ok(who.includes('rahul-viewer:viewer'));
      assert.ok(who.includes('meera-reviewer:reviewer'));
      assert.ok(events.events.every((e) => e.event === 'access.denied'));

      const uploaded = (await server.request('GET', `/workspaces/${ws}/audit/events?event=source.uploaded`)).json<{ events: AuditEventWire[] }>();
      assert.equal(uploaded.events.length, 1);
      assert.equal(uploaded.events[0]?.actor.identityId, 'pri-publisher', 'the real caller is attributed, not the owner');
      assert.equal(uploaded.events[0]?.actor.role, 'publisher');
    } finally {
      await server.stop();
    }
  });
});

test('reviewers can read the audit log (audit permission) but not export it', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, reviewer } = await setup(dirs);
    try {
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/events`, undefined, as(reviewer))).status, 200);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/verify`, undefined, as(reviewer))).status, 200);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/export`, undefined, as(reviewer))).status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('audit log: newest-first paging, filters, and a verifiable hash chain', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      for (let i = 0; i < 3; i++) {
        await server.request('POST', `/workspaces/${ws}/sources?filename=f${i}.txt`, Buffer.from(`doc ${i}`), { 'content-type': 'text/plain' });
      }
      const page1 = (await server.request('GET', `/workspaces/${ws}/audit/events?limit=2`)).json<{ events: AuditEventWire[]; nextBefore?: number }>();
      assert.equal(page1.events.length, 2);
      assert.ok(page1.events[0]!.seq > page1.events[1]!.seq);
      assert.ok(page1.nextBefore !== undefined);
      const page2 = (await server.request('GET', `/workspaces/${ws}/audit/events?limit=100&before=${page1.nextBefore}`)).json<{ events: AuditEventWire[] }>();
      assert.ok(page2.events.every((e) => e.seq < (page1.nextBefore as number)));

      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/events?event=nope`)).status, 400);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/events?limit=0`)).status, 400);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/events?since=not-a-date`)).status, 400);

      const verified = (await server.request('GET', `/workspaces/${ws}/audit/verify`)).json<{ ok: boolean; entries: number; retention: { deletionSupported: boolean } }>();
      assert.equal(verified.ok, true);
      assert.ok(verified.entries >= 7);
      assert.equal(verified.retention.deletionSupported, false);
    } finally {
      await server.stop();
    }
  });
});

test('audit verification detects an edited entry and a removed entry', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const entriesDir = join(dirs.workspaceDataDir, ws, 'audit', 'entries');
      const files = (await readdir(entriesDir)).sort();
      assert.ok(files.length >= 4);

      const target = join(entriesDir, files[1]!);
      const original = await readFile(target, 'utf8');
      const edited = JSON.parse(original) as { result: string };
      edited.result = 'denied';
      await writeFile(target, JSON.stringify(edited));
      const bad = (await server.request('GET', `/workspaces/${ws}/audit/verify`)).json<{ ok: boolean; brokenAt?: { seq: number; reason: string } }>();
      assert.equal(bad.ok, false);
      assert.equal(bad.brokenAt?.reason, 'bad_hash');

      await writeFile(target, original);
      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/verify`)).json<{ ok: boolean }>().ok, true);

      await rm(join(entriesDir, files[2]!));
      const missing = (await server.request('GET', `/workspaces/${ws}/audit/verify`)).json<{ ok: boolean; brokenAt?: { reason: string } }>();
      assert.equal(missing.ok, false);
      assert.equal(missing.brokenAt?.reason, 'missing_entry');
    } finally {
      await server.stop();
    }
  });
});

test('audit export: JSON evidence pack and CSV, admin-only, and the export is itself audited', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const res = await server.request('GET', `/workspaces/${ws}/audit/export`);
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-disposition']), /attachment/);
      const pack = res.json<AuditExportPack>();
      assert.equal(pack.format, 'xo-audit-evidence/1');
      assert.equal(pack.integrity.ok, true);
      assert.equal(pack.workspace.regionLabel, 'India (Mumbai)');
      assert.equal(pack.accessControl.members.length, 4);
      assert.equal(pack.retention.enforcedByServer, false);
      assert.ok(pack.notices.some((n) => /not a certification/.test(n)));

      const csv = await server.request('GET', `/workspaces/${ws}/audit/export?format=csv`);
      assert.equal(csv.status, 200);
      assert.match(String(csv.headers['content-type']), /text\/csv/);
      assert.ok(csv.bodyText.split('\n')[0]!.startsWith('seq,at,actor'));

      assert.equal((await server.request('GET', `/workspaces/${ws}/audit/export?format=xml`)).status, 400);
      const logged = (await server.request('GET', `/workspaces/${ws}/audit/events?event=audit.exported`)).json<{ events: unknown[] }>();
      assert.equal(logged.events.length, 2);
    } finally {
      await server.stop();
    }
  });
});

test('csv export neutralizes spreadsheet formulas and quotes separators', () => {
  const pack = {
    entries: [
      {
        seq: 1,
        at: '2026-10-22T00:00:00.000Z',
        actor: { identityId: '=HYPERLINK("http://evil")', role: 'admin' },
        event: 'source.uploaded',
        target: { kind: 'source', id: 's1', label: 'a,b "c"' },
        result: 'succeeded',
        hash: 'sha256:x',
      },
    ],
  } as unknown as AuditExportPack;
  const csv = auditExportToCsv(pack).split('\n')[1]!;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), csv);
  assert.ok(csv.includes('"a,b ""c"""'), csv);
});

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), canonicalJson({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

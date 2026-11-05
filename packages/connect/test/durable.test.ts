/**
 * D-1 / D-3 through Connect, on the production gate: real files, the real durable EI state store, real ingestion, real evidence
 * lifecycle. Reads RETAIN evidence; deleting a file retires it; excluding never does; removal retires everything and never touches files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditAccessController } from '@xo/audit';
import { InMemoryAuditRecorder, type Candidate, type Deriver } from '@xo/environment-intelligence';
import { ok } from '@xo/types';
import {
  Permissions,
  PermissionManager,
  RuleBasedPolicy,
  establishAuthenticatedPrincipal,
  parsePermissionId,
  type AuthenticatedPrincipal,
  type PolicyRule,
} from '@xo/permissions';
import { createConnectRuntime } from '../src/index.js';
import { principal } from './support.js';

const rule = (permission: string, principalId: string): PolicyRule => {
  const p = parsePermissionId(permission);
  if (!p.ok) throw new Error(permission);
  return { id: `${principalId}-${permission}`, effect: 'ALLOW', match: { permission: p.value.id, principalId } };
};
const GRANTS = ['filesystem.list', 'filesystem.read', 'data.read', 'data.write', 'data.delete'].map((p) => rule(p, 'alice'));
const svcPrincipal = (): AuthenticatedPrincipal => {
  const m = establishAuthenticatedPrincipal({ kind: 'service', id: 'xo-connect' });
  if (!m.ok) throw m.error;
  return m.value;
};
const grantMinter = () => async () => {
  const controller = new AuditAccessController({
    permissionManager: new PermissionManager({
      policy: new RuleBasedPolicy([{ id: 'r', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'xo-connect' } }]),
    }),
  });
  const g = await controller.authorize(svcPrincipal(), 'read');
  if (!g.ok) throw g.error;
  return g.value;
};

interface Dirs {
  readonly root: string;
  readonly state: string;
  readonly ei: string;
}
async function withDirs(fn: (d: Dirs) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-connect-dur-')));
  const root = join(base, 'docs');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'Invoice INV-1001 approved');
  await writeFile(join(root, 'b.md'), 'policy limit 500');
  await writeFile(join(root, 'sub', 'c.txt'), 'nested note');
  try {
    await fn({ root, state: join(base, 'state'), ei: join(base, 'ei') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
const boot = (d: Dirs, rules: PolicyRule[] = GRANTS, readGrant = grantMinter(), deriver?: Deriver) =>
  createConnectRuntime({
    ...(deriver !== undefined ? { deriver } : {}),
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy(rules) }),
    audit: new InMemoryAuditRecorder(),
    stateDir: d.state,
    durable: { dir: d.ei, readGrant, principal: svcPrincipal() },
  });
const alice = principal('alice');

/**
 * TEST-ONLY deriver. The shipped deriver understands only structured organizational records, and the filesystem connector keeps no file
 * text, only strict-pattern business tokens such as INV-1001. This stand-in turns each token into a project entity so the whole chain
 * (retain, derive, search, retire, rebuild, remove) can be proven through the real C6 SDK without inventing product semantics.
 */
const tokenDeriver: Deriver = {
  id: 'test.token-deriver',
  version: '1',
  derive(evidence) {
    const tokens = (evidence.payload['identifiers'] ?? []) as string[];
    return ok(
      tokens.map((t): Candidate => ({ type: 'entity', ref: { kind: 'project', identifiers: [{ scheme: 'project_key', value: t }] } })),
    );
  },
};

test('reads retain evidence; deleting a file retires its evidence; excluding a folder does NOT', async () => {
  await withDirs(async (d) => {
    const rt = await boot(d);
    const { service } = rt;
    try {
      const c = await service.connectFolder(alice, { root: d.root, includeKeys: ['a.txt', 'b.md', 'sub/c.txt'] });
      assert.ok(c.ok, JSON.stringify(c));
      const id = c.value.source.id;
      const r1 = await service.readNow(alice, id);
      assert.ok(r1.ok);
      const rep1 = r1.value.source.history.at(-1)?.read;
      assert.deepEqual([rep1?.status, rep1?.evidence, rep1?.read, rep1?.retired], ['complete', 'retained', 3, 0]);
      const p1 = await service.previewRemoval(alice, id);
      assert.ok(p1.ok && p1.value.evidenceItems >= 3 && p1.value.factDependencies === 'not_available');

      // Excluding by name stops future reading but keeps what was learned.
      const ex = await service.updateSelection(alice, id, { includeKeys: ['a.txt', 'b.md'], excludedNames: ['sub'] });
      assert.ok(ex.ok && ex.value.effects.existingKnowledge === 'kept');
      const r2 = await service.readNow(alice, id);
      assert.ok(r2.ok && r2.value.source.history.at(-1)?.read?.retired === 0);
      const p2 = await service.previewRemoval(alice, id);
      assert.ok(p2.ok && p1.ok && p2.value.evidenceItems >= p1.value.evidenceItems, 'excluding never retires what was learned');

      // Deleting a chosen file retires its evidence at the next read.
      await rm(join(d.root, 'b.md'));
      const r3 = await service.readNow(alice, id);
      assert.ok(r3.ok);
      const rep3 = r3.value.source.history.at(-1)?.read;
      assert.equal(rep3?.retired, 1);
      assert.equal(rep3?.skipped.vanished, 1);
      const p3 = await service.previewRemoval(alice, id);
      assert.ok(p3.ok);
    } finally {
      await rt.close();
    }
  });
});

test('the platform record is durable: after a restart the source is still established, with no re-check', async () => {
  await withDirs(async (d) => {
    const first = boot(d);
    const c = await first.service.connectFolder(alice, { root: d.root, includeKeys: ['a.txt'] });
    assert.ok(c.ok);
    const id = c.value.source.id;
    assert.ok((await first.service.readNow(alice, id)).ok);
    const before = await first.service.previewRemoval(alice, id);
    assert.ok(before.ok && before.value.evidenceItems >= 1);
    await first.close();
    const second = boot(d);
    try {
      const got = await second.service.getSource(alice, id);
      assert.ok(got.ok);
      assert.equal(got.value.state, 'read_complete', 'inventory restored from the journal');
      const p = await second.service.previewRemoval(alice, id);
      assert.ok(p.ok && before.ok && p.value.evidenceItems === before.value.evidenceItems, 'retained evidence survived the restart');
    } finally {
      await second.close();
    }
  });
});

test('removal retires and purges evidence, forgets the source, and never touches the files', async () => {
  await withDirs(async (d) => {
    const rt = boot(d);
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['a.txt', 'b.md'] });
      assert.ok(c.ok);
      const id = c.value.source.id;
      assert.ok((await rt.service.readNow(alice, id)).ok);
      const other = await rt.service.removeSource(principal('mallory'), id);
      assert.ok(!other.ok, 'another principal cannot remove it');
      const prev = await rt.service.previewRemoval(alice, id);
      assert.ok(prev.ok);
      const removed = await rt.service.removeSource(alice, id);
      assert.ok(removed.ok, JSON.stringify(removed));
      assert.deepEqual(removed.value, { removed: true, evidenceItemsRetired: prev.value.evidenceItems, sourceFilesChanged: false });
      assert.equal(await readFile(join(d.root, 'a.txt'), 'utf8'), 'Invoice INV-1001 approved');
      const gone = await rt.service.getSource(alice, id);
      assert.ok(!gone.ok && gone.error.code === 'not_found');
      assert.ok(!(await rt.service.removeSource(alice, id)).ok);
    } finally {
      await rt.close();
    }
  });
});

test('removal needs its own grant: without data.delete nothing is retired and the source stays', async () => {
  await withDirs(async (d) => {
    const rules = GRANTS.filter((r) => !JSON.stringify(r).includes('data.delete'));
    const rt = boot(d, rules);
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['a.txt'] });
      assert.ok(c.ok);
      assert.ok((await rt.service.readNow(alice, c.value.source.id)).ok);
      const r = await rt.service.removeSource(alice, c.value.source.id);
      assert.ok(!r.ok);
      const still = await rt.service.getSource(alice, c.value.source.id);
      assert.ok(still.ok, 'the source is not forgotten when its evidence could not be retired');
    } finally {
      await rt.close();
    }
  });
});

test('fail closed: if the durable state cannot start, every operation is unavailable and nothing is read', async () => {
  await withDirs(async (d) => {
    const rt = boot(d, GRANTS, async () => {
      throw new Error('no grant');
    });
    try {
      assert.deepEqual(await rt.ready, { ok: false });
      for (const r of [
        await rt.service.listSources(alice),
        await rt.service.capabilities(alice),
        await rt.service.previewFolder(alice, { root: d.root }),
      ])
        assert.ok(!r.ok && r.error.code === 'unavailable');
    } finally {
      await rt.close();
    }
  });
});

const count = (r: { ok: boolean; value?: unknown }): number =>
  r.ok ? (r.value as { data: { statements: unknown[] } }).data.statements.length : -1;

test('C7.3: retained evidence becomes searchable knowledge through the C6 SDK; deletion and removal take it away; a restart needs a re-read', async () => {
  await withDirs(async (d) => {
    await writeFile(join(d.root, 'people.txt'), 'approves INV-1001 for PRJ-2042');
    const first = boot(d, GRANTS, grantMinter(), tokenDeriver);
    const svc = first.service;
    const c = await svc.connectFolder(alice, { root: d.root, includeKeys: ['people.txt', 'a.txt'] });
    assert.ok(c.ok);
    const id = c.value.source.id;
    const dash0 = await svc.dashboard(alice);
    assert.ok(dash0.ok && dash0.value.knowledge.availability === 'empty');
    assert.equal(count(await svc.searchKnowledge(alice, { query: 'INV-1001' })), 0, 'nothing is known before anything is read');

    const r1 = await svc.readNow(alice, id);
    assert.ok(r1.ok);
    const rep = r1.value.source.history.at(-1)?.read;
    assert.equal(rep?.evidence, 'retained');
    assert.ok((rep?.assertionsAdded ?? 0) > 0, 'knowledge was derived from what was read');
    const found = await svc.searchKnowledge(alice, { query: 'INV-1001' });
    assert.ok(found.ok);
    assert.ok(count(found) > 0, 'C6 returns statements about what was read');
    assert.ok(
      found.value.data.statements.every((s) => s.evidence.length > 0),
      'every statement cites its evidence',
    );
    assert.equal(found.value.access.completeness, 'visible_scope_only');
    const dash1 = await svc.dashboard(alice);
    assert.ok(dash1.ok && dash1.value.knowledge.availability === 'ready');

    // A principal without data.read on knowledge sees nothing and is told it is denied, by C6 itself.
    const denied = await svc.searchKnowledge(principal('mallory'), { query: 'INV-1001' });
    assert.ok(!denied.ok && denied.error.code === 'denied');

    // Removal: nothing derived outlives its evidence.
    const removed = await svc.removeSource(alice, id);
    assert.ok(removed.ok);
    assert.equal(count(await svc.searchKnowledge(alice, { query: 'INV-1001' })), 0);
    await first.close();
  });
});

test('C7.3: after a restart knowledge is empty until the source is read again, then it is rebuilt from the durable index', async () => {
  await withDirs(async (d) => {
    await writeFile(join(d.root, 'people.txt'), 'approves INV-1001');
    const first = boot(d, GRANTS, grantMinter(), tokenDeriver);
    const c = await first.service.connectFolder(alice, { root: d.root, includeKeys: ['people.txt'] });
    assert.ok(c.ok);
    const id = c.value.source.id;
    assert.ok((await first.service.readNow(alice, id)).ok);
    assert.ok(count(await first.service.searchKnowledge(alice, { query: 'INV-1001' })) > 0);
    await first.close();

    const second = boot(d, GRANTS, grantMinter(), tokenDeriver);
    try {
      const dash = await second.service.dashboard(alice);
      assert.ok(
        dash.ok && dash.value.knowledge.availability === 'empty',
        'the model is memory-only: it says so instead of showing stale knowledge',
      );
      assert.equal(count(await second.service.searchKnowledge(alice, { query: 'INV-1001' })), 0);
      const again = await second.service.readNow(alice, id);
      assert.ok(again.ok);
      assert.ok(
        count(await second.service.searchKnowledge(alice, { query: 'INV-1001' })) > 0,
        'rebuilt from the durable index, no new ingestion needed',
      );
    } finally {
      await second.close();
    }
  });
});

test('C7.3: a deleted file stops answering at the next read', async () => {
  await withDirs(async (d) => {
    await writeFile(join(d.root, 'people.txt'), 'approves INV-1001');
    const rt = boot(d, GRANTS, grantMinter(), tokenDeriver);
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['people.txt'] });
      assert.ok(c.ok);
      assert.ok((await rt.service.readNow(alice, c.value.source.id)).ok);
      assert.ok(count(await rt.service.searchKnowledge(alice, { query: 'INV-1001' })) > 0);
      await rm(join(d.root, 'people.txt'));
      const r = await rt.service.readNow(alice, c.value.source.id);
      assert.ok(r.ok && r.value.source.history.at(-1)?.read?.retired === 1);
      assert.equal(count(await rt.service.searchKnowledge(alice, { query: 'INV-1001' })), 0, 'retired evidence no longer answers');
    } finally {
      await rt.close();
    }
  });
});

test('C7.3 honesty: with the shipped deriver, free text is kept and counted but NOT understood, and the user is told', async () => {
  await withDirs(async (d) => {
    const rt = boot(d);
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['a.txt', 'b.md'] });
      assert.ok(c.ok);
      const r = await rt.service.readNow(alice, c.value.source.id);
      assert.ok(r.ok);
      const rep = r.value.source.history.at(-1)?.read;
      assert.equal(rep?.evidence, 'retained');
      assert.equal(rep?.assertionsAdded, 0);
      assert.equal(rep?.notUnderstood, 2, 'both files were read and kept, neither became knowledge');
      const dash = await rt.service.dashboard(alice);
      assert.ok(dash.ok && dash.value.knowledge.availability === 'empty');
      assert.match(dash.ok ? dash.value.knowledge.reason : '', /structured organizational records/);
      assert.equal(count(await rt.service.searchKnowledge(alice, { query: 'INV-1001' })), 0);
    } finally {
      await rt.close();
    }
  });
});

const ORG_FILE = JSON.stringify({
  schema: 'ei.org-record.v1',
  records: [
    {
      type: 'directory_entry',
      person: { kind: 'person', ids: { email: 'priya.sharma@contoso.example', employee_id: 'E-1042' } },
      title: 'Senior Finance Manager',
      team: { kind: 'team', ids: { team_key: 'FIN-CORE' } },
    },
    {
      type: 'work_item',
      project: { kind: 'project', ids: { project_key: 'PRJ-2042' } },
      owner: { kind: 'person', ids: { email: 'priya.sharma@contoso.example' } },
      status: 'active',
    },
  ],
});

test('D-1(a): a structured record file becomes real knowledge through the default deriver; free text beside it is reported as not understood', async () => {
  await withDirs(async (d) => {
    await writeFile(join(d.root, 'org.json'), ORG_FILE);
    const rt = boot(d); // default deriver: nothing injected
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['org.json', 'a.txt'] });
      assert.ok(c.ok);
      const r = await rt.service.readNow(alice, c.value.source.id);
      assert.ok(r.ok);
      const rep = r.value.source.history.at(-1)?.read;
      assert.equal(rep?.evidence, 'retained');
      assert.ok((rep?.assertionsAdded ?? 0) >= 4, 'title, team membership and ownership were derived');
      assert.equal(rep?.notUnderstood, 1, 'only the free-text file was not understood');
      const byProject = await rt.service.searchKnowledge(alice, { query: 'PRJ-2042' });
      assert.ok(byProject.ok && byProject.value.data.statements.length > 0);
      assert.ok(byProject.value.data.statements.every((s) => s.evidence.length > 0));
      const claims = await rt.service.searchKnowledge(alice, { query: { select: 'claims' } as never });
      assert.ok(claims.ok);
      assert.match(JSON.stringify(claims.value.data), /Senior Finance Manager/);
      const dash = await rt.service.dashboard(alice);
      assert.ok(dash.ok && dash.value.knowledge.availability === 'ready');
      // Deleting the record file retires its evidence and the knowledge goes with it.
      await rm(join(d.root, 'org.json'));
      const again = await rt.service.readNow(alice, c.value.source.id);
      assert.ok(again.ok && again.value.source.history.at(-1)?.read?.retired === 1);
      assert.equal(count(await rt.service.searchKnowledge(alice, { query: 'PRJ-2042' })), 0);
    } finally {
      await rt.close();
    }
  });
});

test('D-1(a): a record file with ANY record it does not understand is refused whole; JSON that is not a record file keeps no records', async () => {
  await withDirs(async (d) => {
    const bad = JSON.parse(ORG_FILE) as { records: unknown[] };
    bad.records.push({ type: 'something_unknown', x: 1 });
    await writeFile(join(d.root, 'partial.json'), JSON.stringify(bad));
    await writeFile(join(d.root, 'plain.json'), JSON.stringify({ hello: 'world', secret: 'do-not-keep-me' }));
    const rt = boot(d);
    try {
      const c = await rt.service.connectFolder(alice, { root: d.root, includeKeys: ['partial.json', 'plain.json'] });
      assert.ok(c.ok);
      const r = await rt.service.readNow(alice, c.value.source.id);
      assert.ok(r.ok);
      const rep = r.value.source.history.at(-1)?.read;
      assert.equal(rep?.assertionsAdded, 0, 'no half-understood file contributes anything');
      assert.equal(rep?.notUnderstood, 2);
      assert.equal(count(await rt.service.searchKnowledge(alice, { query: 'PRJ-2042' })), 0);
      assert.equal(
        count(await rt.service.searchKnowledge(alice, { query: 'do-not-keep-me' })),
        0,
        'non-record JSON content is never retained',
      );
    } finally {
      await rt.close();
    }
  });
});

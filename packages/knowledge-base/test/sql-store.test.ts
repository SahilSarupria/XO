/**
 * The SQL knowledge store: tamper detection in the database, writers serialised across connections (two reviewers can never
 * both approve against the same head), schema guard, live backup.
 */
import { strict as assert } from 'node:assert';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  KnowledgeBase,
  type KnowledgeError,
  IntegrityError,
  SqlKnowledgeStore,
  backupSqliteKnowledge,
  copyKnowledge,
  FsKnowledgeStore,
  restoreSqliteKnowledge,
  KnowledgeTransferError,
  sqliteDriver,
  type ClaimRecord,
} from '../src/index.js';

const A = { id: 'u1', kind: 'user' };
const claim = (id: string, subject: string, value: string): ClaimRecord => ({
  kind: 'claim',
  id,
  tenantId: 't1',
  type: 'xo:heuristic',
  subject: { literal: subject },
  predicate: 'xo:heuristic',
  object: { value },
  polarity: 'positive',
  authority: { level: 'source', basis: 'stated' },
  text: `${subject}: ${value}`,
  evidence: [
    {
      sourceDigestSha256: 'a'.repeat(64),
      sourceName: 'p.md',
      locator: { section: ['S'] },
      method: { kind: 'source', name: 't', version: '1' },
    },
  ],
  derivation: 'source',
  confidence: 0.9,
  recordedAt: '2026-01-01T00:00:00.000Z',
});
const hex = (n: number): string => n.toString(16).padStart(24, '0');

async function open(path: string, tenant = 't1') {
  const driver = await sqliteDriver(path);
  return { driver, kb: new KnowledgeBase(await SqlKnowledgeStore.open(driver, tenant, { ownsDriver: true })) };
}

it('a row altered in the database is detected, not trusted', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'kbsql-')), 'k.sqlite');
  const { driver, kb } = await open(path);
  const c = claim(`clm_${hex(1)}`, 'x', 'y');
  const s = await kb.approve(
    (await kb.propose({ operations: [{ op: 'add', record: c }], origin: { kind: 'manual' }, proposedBy: A }))!.changeSetId,
    A,
    'ok',
  );
  await driver.run('UPDATE kb_records SET body = replace(body, \'"y"\', \'"z"\') WHERE id = ?', [c.id]);
  await assert.rejects(kb.records(s.stateId), IntegrityError);
  await driver.run("UPDATE kb_events SET body = replace(body, 'change-set.proposed', 'change-set.Proposed') WHERE seq = 1");
  await assert.rejects(kb.head(), IntegrityError);
  await kb.store.close();
});

it('two writers on separate connections: exactly one approval lands on a head; the other is told to re-propose', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'kbsql-')), 'k.sqlite');
  const a = await open(path);
  const b = await open(path);
  const p1 = await a.kb.propose({
    operations: [{ op: 'add', record: claim(`clm_${hex(2)}`, 'p', '1') }],
    origin: { kind: 'manual', ref: 'a' },
    proposedBy: A,
  });
  const p2 = await b.kb.propose({
    operations: [{ op: 'add', record: claim(`clm_${hex(3)}`, 'q', '2') }],
    origin: { kind: 'manual', ref: 'b' },
    proposedBy: A,
  });
  const results = await Promise.allSettled([a.kb.approve(p1!.changeSetId, A, 'ok'), b.kb.approve(p2!.changeSetId, A, 'ok')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((refused.reason as KnowledgeError).code, 'stale_base');
  const events = await a.kb.store.events();
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  await a.kb.store.close();
  await b.kb.store.close();
});

it('tenants share a database without seeing each other', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'kbsql-')), 'k.sqlite');
  const t1 = await open(path, 't1');
  const t2 = await open(path, 't2');
  await t1.kb.approve(
    (await t1.kb.propose({
      operations: [{ op: 'add', record: claim(`clm_${hex(4)}`, 'secret', 'v') }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!.changeSetId,
    A,
    'ok',
  );
  assert.equal((await t2.kb.head()).entries.length, 0);
  assert.equal((await t2.kb.store.events()).length, 0);
  await t1.kb.store.close();
  await t2.kb.store.close();
});

it('a database written by a newer schema is refused; a live backup reopens and verifies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kbsql-'));
  const { driver, kb } = await open(join(dir, 'k.sqlite'));
  const s = await kb.approve(
    (await kb.propose({
      operations: [{ op: 'add', record: claim(`clm_${hex(5)}`, 'b', '1') }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!.changeSetId,
    A,
    'ok',
  );
  await backupSqliteKnowledge(driver, join(dir, 'copy.sqlite'));
  const copy = await open(join(dir, 'copy.sqlite'));
  assert.equal((await copy.kb.head()).stateId, s.stateId);
  assert.deepEqual(await copy.kb.verifyState(s.stateId), []);
  await copy.kb.store.close();
  await driver.run('UPDATE kb_schema SET version = 99');
  await assert.rejects(SqlKnowledgeStore.open(driver, 't1'), /newer XO/);
  await kb.store.close();
});

it('ADR 0031: a backup is restored only after it verifies; the restored database serves the same head; a damaged backup changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kbsql-'));
  const live = join(dir, 'knowledge.sqlite');
  const { driver, kb } = await open(live);
  const first = await kb.approve(
    (await kb.propose({
      operations: [{ op: 'add', record: claim(`clm_${hex(7)}`, 'r', '1') }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!.changeSetId,
    A,
    'ok',
  );
  await backupSqliteKnowledge(driver, join(dir, 'backup.sqlite'));
  // Work after the backup: the restore must roll it back.
  await kb.approve(
    (await kb.propose({
      operations: [{ op: 'add', record: claim(`clm_${hex(8)}`, 'r2', '2') }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!.changeSetId,
    A,
    'ok',
  );
  await kb.store.close();

  // A tampered backup is refused and the live database is untouched.
  await copyFile(join(dir, 'backup.sqlite'), join(dir, 'tampered.sqlite'));
  const t = await sqliteDriver(join(dir, 'tampered.sqlite'));
  await t.run('UPDATE kb_records SET body = replace(body, \'"1"\', \'"9"\')');
  await t.close();
  await assert.rejects(restoreSqliteKnowledge(join(dir, 'tampered.sqlite'), live), IntegrityError);
  await writeFile(join(dir, 'garbage.sqlite'), 'not a database');
  await assert.rejects(restoreSqliteKnowledge(join(dir, 'garbage.sqlite'), live));
  const still = await open(live);
  assert.notEqual((await still.kb.head()).stateId, first.stateId, 'the refused restores changed nothing');
  await still.kb.store.close();

  const report = await restoreSqliteKnowledge(join(dir, 'backup.sqlite'), live);
  assert.equal(report.tenants.length, 1);
  assert.equal(report.tenants[0]!.states, 1);
  const restored = await open(live);
  assert.equal((await restored.kb.head()).stateId, first.stateId);
  assert.deepEqual(await restored.kb.verifyState(first.stateId), []);
  await restored.kb.store.close();
});

it('ADR 0031: knowledge moves from the file store to SQL with the same event chain; a non-empty target is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kbmig-'));
  const fs = await FsKnowledgeStore.open(join(dir, 'files'), 't1');
  const fkb = new KnowledgeBase(fs);
  const s1 = await fkb.approve(
    (await fkb.propose({
      operations: [{ op: 'add', record: claim(`clm_${hex(10)}`, 'm', '1') }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!.changeSetId,
    A,
    'ok',
  );
  const rejected = await fkb.propose({
    operations: [{ op: 'add', record: claim(`clm_${hex(11)}`, 'm2', '2') }],
    origin: { kind: 'manual' },
    proposedBy: A,
  });
  await fkb.reject(rejected!.changeSetId, A, 'no');
  const { kb } = await open(join(dir, 'k.sqlite'));
  const report = await copyKnowledge(fs, kb.store);
  assert.equal(report.states, 1);
  assert.equal(report.changeSets, 2);
  assert.equal(report.decisions, 2);
  assert.equal(report.headEventDigest, (await fs.events()).at(-1)!.digest);
  assert.equal((await kb.head()).stateId, s1.stateId);
  assert.deepEqual(await kb.verifyState(s1.stateId), []);
  await assert.rejects(copyKnowledge(fs, kb.store), KnowledgeTransferError);
  await kb.store.close();
});

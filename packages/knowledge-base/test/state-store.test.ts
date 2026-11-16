/**
 * UW-4b (UAC-13, ADR 0017 spike, ADR 0034) — the knowledge state store under migration, crashes and concurrent approvals.
 *
 * Crash and concurrency tests run real separate processes (`helpers/approve-child.ts`) on one SQLite file: a process killed
 * with SIGKILL at every statement of an approval, and two processes approving against the same head at once.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IntegrityError,
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeBase,
  SqlKnowledgeStore,
  StaleHeadError,
  restoreSqliteKnowledge,
  sqliteDriver,
  stateContentRoot,
  verifySqlKnowledge,
  type ClaimRecord,
  type KnowledgeError,
  type SqlDriver,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'knowledge-schema-1.sqlite');
const CHILD = join(here, 'helpers', 'approve-child.ts');
/** What the schema-1 fixture holds (written by the schema-1 code; see fixtures/README.md). */
const V1 = {
  acme: { head: 'ks_32c6e16451afc304cdaef107', pending: 'cs_9d29168101a0b0c138af8cae' },
  globex: { head: 'ks_d0bdc13844fdd416db7b4826', pending: 'cs_0ec1e21a97075fa002de083b' },
} as const;

const A = { id: 'u-author', kind: 'user' };
const R = { id: 'u-reviewer', kind: 'user' };
let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 0, 1) + (clock += 1000)).toISOString();
const claim = (i: number, text: string): ClaimRecord => ({
  kind: 'claim',
  id: `clm_${i.toString(16).padStart(24, '0')}`,
  tenantId: 't1',
  type: 'xo:heuristic',
  subject: { literal: `s${i}` },
  predicate: 'xo:heuristic',
  object: { value: text },
  polarity: 'positive',
  authority: { level: 'source', basis: 'policy' },
  text,
  evidence: [{ sourceDigestSha256: 'a'.repeat(64), sourceName: 'p.md', locator: {}, method: { kind: 'source', name: 't', version: '1' } }],
  derivation: 'source',
  confidence: 1,
  recordedAt: '2026-01-01T00:00:00.000Z',
});

async function tmpDb(from?: string): Promise<string> {
  const p = join(await mkdtemp(join(tmpdir(), 'kb-state-')), 'k.sqlite');
  if (from !== undefined) await copyFile(from, p);
  return p;
}
async function open(path: string, tenant = 't1'): Promise<{ driver: SqlDriver; kb: KnowledgeBase }> {
  const driver = await sqliteDriver(path);
  return { driver, kb: new KnowledgeBase(await SqlKnowledgeStore.open(driver, tenant), now) };
}
async function propose(kb: KnowledgeBase, i: number): Promise<string> {
  return (await kb.propose({
    operations: [{ op: 'add', record: claim(i, `rule ${i}`) }],
    origin: { kind: 'manual', ref: `r${i}` },
    proposedBy: A,
  }))!.changeSetId;
}

interface ChildResult {
  readonly ok?: boolean;
  readonly stateId?: string;
  readonly code?: string;
  readonly statements?: number;
  readonly signal: NodeJS.Signals | null;
}
function child(db: string, tenant: string, cs: string, killAt = 0): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', CHILD, db, tenant, cs, String(killAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (_code, signal) => {
      const line = out.trim().split('\n').pop();
      if (signal === null && (line === undefined || line === '')) reject(new Error(`child printed nothing: ${err}`));
      else resolve({ ...(line ? (JSON.parse(line) as object) : {}), signal });
    });
  });
}

describe('UW-4b schema 2 migration (a real schema-1 database)', () => {
  it('migrates schema 1 → 2: each tenant’s head pointer is backfilled from its log; knowledge and pending work carry over', async () => {
    const path = await tmpDb(FIXTURE);
    const raw = await sqliteDriver(path);
    assert.deepEqual(
      (await raw.query<{ version: number }>('SELECT version FROM kb_schema')).map((r) => Number(r.version)),
      [1],
    );
    await raw.close();
    for (const tenant of ['acme', 'globex'] as const) {
      const { driver, kb } = await open(path, tenant);
      assert.equal((await kb.head()).stateId, V1[tenant].head);
      const ptr = await kb.store.getHead!();
      assert.equal(ptr!.stateId, V1[tenant].head);
      assert.equal(ptr!.contentRoot, stateContentRoot(await kb.head()));
      assert.deepEqual(await kb.verifyHead(), []);
      assert.deepEqual(await kb.verifyState(V1[tenant].head, new Set(['a'.repeat(64)])), []);
      assert.equal((await kb.records(V1[tenant].head)).length, 3);
      // A change set proposed under schema 1 approves under schema 2, moving the pointer by compare-and-swap.
      const s = await kb.approve(V1[tenant].pending, R, 'after migration');
      assert.equal((await kb.store.getHead!())!.stateId, s.stateId);
      assert.deepEqual(await kb.verifyHead(), []);
      await driver.close();
    }
    const driver = await sqliteDriver(path);
    assert.deepEqual(
      (await driver.query<{ version: number }>('SELECT version FROM kb_schema')).map((r) => Number(r.version)),
      [KNOWLEDGE_SCHEMA_VERSION],
    );
    assert.equal((await verifySqlKnowledge(driver)).tenants.length, 2);
    await driver.close();
  });

  it('a schema-1 database whose log does not verify is not migrated: the transaction rolls back and schema 1 stays', async () => {
    const path = await tmpDb(FIXTURE);
    const raw = await sqliteDriver(path);
    await raw.run("UPDATE kb_events SET body = replace(body, 'u-reviewer', 'u-mallory') WHERE tenant = 'acme' AND seq = 3");
    await assert.rejects(
      SqlKnowledgeStore.open(raw, 'acme'),
      (e: Error) => e instanceof IntegrityError && /event 3 does not verify/.test(e.message),
    );
    assert.deepEqual(
      (await raw.query<{ version: number }>('SELECT version FROM kb_schema')).map((r) => Number(r.version)),
      [1],
    );
    assert.equal((await raw.query("SELECT name FROM sqlite_master WHERE name = 'kb_heads'")).length, 0, 'no half-migrated schema');
    await raw.close();
  });

  it('migration is idempotent and safe when many processes start at once', async () => {
    const path = await tmpDb(FIXTURE);
    const drivers = await Promise.all([1, 2, 3].map(() => sqliteDriver(path)));
    await Promise.all(drivers.map((d, i) => SqlKnowledgeStore.open(d, i === 0 ? 'acme' : 'globex')));
    const rows = await drivers[0]!.query<{ tenant: string; state_id: string }>('SELECT tenant, state_id FROM kb_heads ORDER BY tenant');
    assert.deepEqual(
      rows.map((r) => [r.tenant, r.state_id]),
      [
        ['acme', V1.acme.head],
        ['globex', V1.globex.head],
      ],
    );
    for (const d of drivers) await d.close();
  });

  it('restoring a schema-1 backup brings it to schema 2 on the staging copy; the backup itself is untouched', async () => {
    const backup = await tmpDb(FIXTURE);
    const target = await tmpDb();
    const v = await restoreSqliteKnowledge(backup, target);
    assert.equal(v.schemaVersion, KNOWLEDGE_SCHEMA_VERSION);
    const { driver, kb } = await open(target, 'acme');
    assert.equal((await kb.head()).stateId, V1.acme.head);
    await driver.close();
    const b = await sqliteDriver(backup);
    assert.equal(Number((await b.query<{ version: number }>('SELECT version FROM kb_schema'))[0]!.version), 1);
    await b.close();
  });
});

describe('UW-4b head pointer and content root', () => {
  it('state ids and content roots are deterministic: the same approvals rebuild the same states', async () => {
    const build = async (): Promise<string[]> => {
      const { driver, kb } = await open(await tmpDb());
      const out: string[] = [];
      for (const i of [1, 2, 3]) {
        const s = await kb.approve(await propose(kb, i), R, 'ok');
        out.push(`${s.stateId} ${stateContentRoot(s)}`);
      }
      await driver.close();
      return out;
    };
    assert.deepEqual(await build(), await build());
  });

  it('the content root names content, not history: two paths to the same knowledge share a root but not an id', async () => {
    const one = await open(await tmpDb());
    const both = await one.kb.approve(
      (await one.kb.propose({
        operations: [
          { op: 'add', record: claim(1, 'rule 1') },
          { op: 'add', record: claim(2, 'rule 2') },
        ],
        origin: { kind: 'manual', ref: 'both' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    const two = await open(await tmpDb());
    await two.kb.approve(await propose(two.kb, 2), R, 'ok');
    const after = await two.kb.approve(await propose(two.kb, 1), R, 'ok');
    assert.notEqual(both.stateId, after.stateId);
    assert.equal(stateContentRoot(both), stateContentRoot(after));
    assert.equal(await one.kb.contentRoot(both.stateId), await two.kb.contentRoot(after.stateId));
    await one.driver.close();
    await two.driver.close();
  });

  it('the head moves only by compare-and-swap inside a transaction', async () => {
    const { driver, kb } = await open(await tmpDb());
    const s1 = await kb.approve(await propose(kb, 1), R, 'ok');
    const store = kb.store as SqlKnowledgeStore;
    await assert.rejects(store.casHead(s1.stateId, { stateId: 'ks_x', contentRoot: 'sha256:0', eventSeq: 99 }), IntegrityError);
    await assert.rejects(
      store.exclusive(() => store.casHead('ks_not_the_head', { stateId: 'ks_x', contentRoot: 'sha256:0', eventSeq: 99 })),
      (e: Error) => e instanceof StaleHeadError && e.actual === s1.stateId,
    );
    await assert.rejects(
      store.exclusive(() => store.casHead(null, { stateId: 'ks_x', contentRoot: 'sha256:0', eventSeq: 99 })),
      StaleHeadError,
    );
    assert.equal((await kb.head()).stateId, s1.stateId);
    await driver.close();
  });

  it('a head pointer that disagrees with the log is an integrity fault, not a silent choice', async () => {
    const { driver, kb } = await open(await tmpDb());
    const s1 = await kb.approve(await propose(kb, 1), R, 'ok');
    await kb.approve(await propose(kb, 2), R, 'ok');
    await driver.run('UPDATE kb_heads SET state_id = ?', [s1.stateId]);
    await assert.rejects(kb.head(), (e: KnowledgeError) => e.code === 'integrity' && /head pointer names/.test(e.message));
    assert.deepEqual(
      (await kb.verifyHead()).map((f) => f.code),
      ['head-diverged', 'head-content-root'], // it names an older state, and the stored root (the newer state's) does not match it
    );
    await assert.rejects(verifySqlKnowledge(driver), /head pointer names/);
    await driver.close();
  });
});

describe('UW-4b crash injection (UAC-13): an approval is all-or-nothing at every statement', () => {
  it('SIGKILL at each statement of an approval leaves the previous head or the next one, never a mix', { timeout: 240_000 }, async () => {
    // A base database with one approved state and one pending change set.
    const base = await tmpDb();
    const b = await open(base);
    const s1 = await b.kb.approve(await propose(b.kb, 1), R, 'ok');
    const pending = await propose(b.kb, 2);
    await b.driver.close();

    const dry = await child(await tmpDb(base), 't1', pending, 0);
    assert.equal(dry.ok, true);
    const statements = dry.statements!;
    assert.ok(statements >= 10, `an approval issues ${statements} statements`);

    let landed = 0;
    let rolledBack = 0;
    for (let k = 1; k <= statements; k++) {
      const db = await tmpDb(base);
      const r = await child(db, 't1', pending, k);
      assert.equal(r.signal, 'SIGKILL', `killed at statement ${k}`);
      const { driver, kb } = await open(db);
      const head = await kb.head();
      const decision = await kb.store.getDecision(pending);
      const created = (await kb.store.events()).filter((e) => e.type === 'state.created');
      assert.deepEqual(await kb.verifyHead(), [], `head agrees with the log after a kill at ${k}`);
      if (head.stateId === s1.stateId) {
        rolledBack++;
        assert.equal(decision, undefined, `no decision without the state (kill at ${k})`);
        assert.equal(created.length, 1);
        // Nothing was half-done: the same change set approves cleanly now.
        const s2 = await kb.approve(pending, R, 'retry');
        assert.equal(s2.stateId, dry.stateId);
      } else {
        landed++;
        assert.equal(head.stateId, dry.stateId);
        assert.equal(decision?.status, 'approved');
        assert.equal(created.length, 2);
      }
      await driver.close();
    }
    // Every kill inside the transaction (before COMMIT) rolls back.
    assert.equal(rolledBack, statements);
    assert.equal(landed, 0);
  });
});

describe('UW-4b concurrent activation (UAC-13): two processes, one head', () => {
  it(
    'two processes approving against the same head at once: exactly one wins, the other is told to re-propose',
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < 3; round++) {
        const db = await tmpDb();
        const o = await open(db);
        await o.kb.approve(await propose(o.kb, 10 + round), R, 'ok');
        const a = await propose(o.kb, 100 + round);
        const c = await propose(o.kb, 200 + round);
        await o.driver.close();
        const results = await Promise.all([child(db, 't1', a), child(db, 't1', c)]);
        assert.equal(results.filter((r) => r.ok === true).length, 1, `round ${round}: one winner`);
        const loser = results.find((r) => r.ok !== true)!;
        assert.equal(loser.code, 'stale_base');
        const v = await open(db);
        assert.equal((await v.kb.head()).stateId, results.find((r) => r.ok)!.stateId);
        assert.deepEqual(await v.kb.verifyHead(), []);
        assert.equal((await v.kb.store.events()).filter((e) => e.type === 'state.created').length, 2);
        await v.driver.close();
      }
    },
  );
});

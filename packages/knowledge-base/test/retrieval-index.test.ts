import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FsKnowledgeStore,
  KnowledgeBase,
  SqlKnowledgeStore,
  buildKnowledgeIndex,
  queryKnowledgeIndex,
  sqliteDriver,
  type ClaimRecord,
  type KnowledgeError,
  type SqlDriver,
} from '../src/index.js';

const A = { id: 'u-author', kind: 'user' };
const R = { id: 'u-reviewer', kind: 'user' };
let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 0, 1) + (clock += 1000)).toISOString();
const claim = (tenant: string, i: number, text: string): ClaimRecord => ({
  kind: 'claim',
  id: `clm_${i.toString(16).padStart(24, '0')}`,
  tenantId: tenant,
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
const TEXTS = [
  'Refunds over 500 need a manager approval',
  'Refunds under 500 are approved by the agent',
  'Shipping takes two days within the country',
  'International shipping needs a customs form',
  'A manager approves every refund to a business account',
];

async function sql(tenant = 't1'): Promise<{ kb: KnowledgeBase; driver: SqlDriver; path: string }> {
  const path = join(await mkdtemp(join(tmpdir(), 'kb-ix-')), 'k.sqlite');
  const driver = await sqliteDriver(path);
  return { kb: new KnowledgeBase(await SqlKnowledgeStore.open(driver, tenant), now), driver, path };
}
async function load(kb: KnowledgeBase, tenant = 't1'): Promise<string> {
  const cs = await kb.propose({
    operations: TEXTS.map((t, i) => ({ op: 'add' as const, record: claim(tenant, i + 1, t) })),
    origin: { kind: 'manual', ref: 'load' },
    proposedBy: A,
  });
  return (await kb.approve(cs!.changeSetId, R, 'ok')).stateId;
}

/** The pre-UW-4c search, kept here as the reference: BM25 over the state's active records, recomputed per call. */
async function reference(kb: KnowledgeBase, stateId: string, text: string, limit = 10): Promise<{ id: string; score: number }[]> {
  const tok = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter((t) => t.length > 1);
  const docs = (await kb.records(stateId)).map(({ record }) => ({ id: record.id, t: tok((record as ClaimRecord).text) }));
  const q = [...new Set(tok(text))];
  const avg = docs.reduce((n, d) => n + d.t.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.t)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs
    .map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.t.filter((x) => x === t).length;
        if (f === 0) continue;
        const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.t.length) / avg)));
      }
      return { id: d.id, score: Math.round(score * 1000) / 1000 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

describe('UW-4c retrieval index', () => {
  it('ranks exactly as the scan it replaces', async () => {
    const { kb, driver } = await sql();
    const s = await load(kb);
    for (const q of ['refund manager', 'shipping', 'customs form', 'approved by the agent', 'nothing matches this'])
      assert.deepEqual(
        (await kb.search(s, q)).map((h) => ({ id: h.recordId, score: h.score })),
        await reference(kb, s, q),
        q,
      );
    await driver.close();
  });

  it('is persisted per state, and a rebuild is identical to what was stored', async () => {
    const { kb, driver, path } = await sql();
    const s = await load(kb);
    await kb.search(s, 'refund');
    const rows = await driver.query<{ id: string }>('SELECT id FROM kb_indexes');
    assert.deepEqual(
      rows.map((r) => r.id),
      [s],
    );
    const stored = await kb.store.getIndex!(s);
    assert.deepEqual(await kb.index(s, { rebuild: true }), stored);
    // A second process reads the stored index; dropping every index loses nothing.
    const other = new KnowledgeBase(await SqlKnowledgeStore.open(await sqliteDriver(path), 't1'), now);
    assert.deepEqual(await other.index(s), stored);
    await driver.run('DELETE FROM kb_indexes');
    assert.deepEqual(await new KnowledgeBase(kb.store, now).index(s), stored);
    await driver.close();
  });

  it('is deterministic: the same state built from records in any order gives the same index', async () => {
    const { kb, driver } = await sql();
    const s = await load(kb);
    const state = await kb.state(s);
    const recs = (await kb.records(s, { lifecycle: 'any' })).map((x) => x.record);
    const fwd = buildKnowledgeIndex(state, new Map(recs.map((r) => [r.id, r])));
    const rev = buildKnowledgeIndex(state, new Map([...recs].reverse().map((r) => [r.id, r])));
    assert.deepEqual(fwd, rev);
    await driver.close();
  });

  it('searches approved knowledge by default; other lifecycles only when asked; filters rank over what they leave', async () => {
    const { kb, driver } = await sql();
    const s1 = await load(kb);
    const s2 = await kb.approve(
      (await kb.propose({
        operations: [{ op: 'retire', recordId: claim('t1', 1, '').id, lifecycle: 'expired', reason: 'old policy' }],
        origin: { kind: 'manual', ref: 'x' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    const expired = claim('t1', 1, '').id;
    assert.ok(
      (await kb.search(s1, 'refunds over 500')).some((h) => h.recordId === expired),
      'in the old state it is active',
    );
    assert.ok(!(await kb.search(s2.stateId, 'refunds over 500')).some((h) => h.recordId === expired), 'expired is not searched by default');
    const withExpired = await kb.search(s2.stateId, 'refunds over 500', 10, { lifecycle: ['active', 'expired'] });
    assert.equal(withExpired.find((h) => h.recordId === expired)?.lifecycle, 'expired');
    // The filter applies before scoring: statistics come from the filtered set.
    const index = await kb.index(s2.stateId);
    const onlyExpired = queryKnowledgeIndex(index, { text: 'refunds over 500', lifecycle: ['expired'] });
    assert.deepEqual(
      onlyExpired.map((h) => h.id),
      [expired],
    );
    await driver.close();
  });

  it('is keyed by tenant and state: an index of another tenant or state is refused, never used', async () => {
    const { kb, driver, path } = await sql();
    const s = await load(kb);
    const other = new KnowledgeBase(await SqlKnowledgeStore.open(await sqliteDriver(path), 't2'), now);
    const s2 = await load(other, 't2');
    await other.search(s2, 'refund');
    // Tenant isolation: t1 cannot see t2's state or index at all.
    await assert.rejects(kb.search(s2, 'refund'), (e: KnowledgeError) => e.code === 'not_found');
    // A row whose body was swapped for another state's index is detected.
    await kb.search(s, 'refund');
    const body = (await driver.query<{ body: string; digest: string }>("SELECT body, digest FROM kb_indexes WHERE tenant = 't2'"))[0]!;
    await driver.run("UPDATE kb_indexes SET body = ?, digest = ? WHERE tenant = 't1'", [body.body, body.digest]);
    await assert.rejects(new KnowledgeBase(kb.store, now).search(s, 'refund'), (e: KnowledgeError) => e.code === 'integrity');
    await driver.close();
  });

  it('a store without persisted indexes (the file store) builds the same index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-ix-fs-'));
    const fs = new KnowledgeBase(await FsKnowledgeStore.open(dir, 't1'), now);
    const { kb, driver } = await sql();
    const a = await load(fs);
    const b = await load(kb);
    assert.equal(a, b, 'same approvals, same state id on both stores');
    assert.deepEqual(await fs.index(a), await kb.index(b));
    await driver.close();
  });
});

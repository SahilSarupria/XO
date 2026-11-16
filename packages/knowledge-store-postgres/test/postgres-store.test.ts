/**
 * The BKB on PostgreSQL. Runs when `XO_TEST_POSTGRES_URL` names a database (CI and release verification set it); skipped,
 * with the reason, otherwise. Every test uses its own random tenants, so runs never interfere.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { IntegrityError, KnowledgeBase, SqlKnowledgeStore, type ClaimRecord, type KnowledgeError } from '@xo/knowledge-base';
import { pg, postgresDriver } from '../src/index.js';

const URL = process.env['XO_TEST_POSTGRES_URL'];
const skip = URL === undefined ? 'XO_TEST_POSTGRES_URL is not set' : false;
const pool = URL !== undefined ? new pg.Pool({ connectionString: URL, max: 8 }) : undefined;
after(async () => pool?.end());

const A = { id: 'u1', kind: 'user' };
const tenant = (): string => `t_${randomBytes(6).toString('hex')}`;
const claim = (t: string, n: number, subject: string, value: string): ClaimRecord => ({
  kind: 'claim',
  id: `clm_${randomBytes(12).toString('hex')}`,
  tenantId: t,
  type: 'xo:heuristic',
  subject: { literal: subject },
  predicate: 'xo:heuristic',
  object: { value },
  polarity: 'positive',
  authority: { level: 'source', basis: 'stated' },
  text: `${subject}: ${value} ${n}`,
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
const kbFor = async (t: string) => new KnowledgeBase(await SqlKnowledgeStore.open(postgresDriver(pool!), t));

describe('@xo/knowledge-store-postgres', { skip }, () => {
  it('propose → approve → pinned search, conflicts kept, verify', async () => {
    const t = tenant();
    const kb = await kbFor(t);
    const a = claim(t, 1, 'refund over 500', 'deny');
    const b = claim(t, 2, 'refund over 500', 'approve');
    const cs = await kb.propose({
      operations: [
        { op: 'add', record: a },
        { op: 'add', record: b },
      ],
      origin: { kind: 'manual' },
      proposedBy: A,
    });
    const s = await kb.approve(cs!.changeSetId, A, 'ok');
    assert.equal(s.conflicts.length, 1);
    assert.equal((await kb.search(s.stateId, 'refund')).length, 2);
    assert.deepEqual(await kb.verifyState(s.stateId), []);
    assert.equal((await kb.head()).stateId, s.stateId);
  });

  it('ten concurrent approvals against one head: exactly one lands, the chain stays whole', async () => {
    const t = tenant();
    const kbs = await Promise.all(Array.from({ length: 10 }, () => kbFor(t)));
    const proposals = [];
    for (const [i, kb] of kbs.entries())
      proposals.push(
        await kb.propose({
          operations: [{ op: 'add', record: claim(t, i, `s${i}`, 'v') }],
          origin: { kind: 'manual', ref: `r${i}` },
          proposedBy: A,
        }),
      );
    const results = await Promise.allSettled(kbs.map((kb, i) => kb.approve(proposals[i]!.changeSetId, A, 'ok')));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal((r.reason as KnowledgeError).code, 'stale_base');
    const events = await kbs[0]!.store.events();
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
    );
  });

  it('tenants are isolated; a row altered in the database is detected', async () => {
    const t1 = tenant();
    const t2 = tenant();
    const k1 = await kbFor(t1);
    const k2 = await kbFor(t2);
    const c = claim(t1, 1, 'secret', 'v');
    const s = await k1.approve(
      (await k1.propose({ operations: [{ op: 'add', record: c }], origin: { kind: 'manual' }, proposedBy: A }))!.changeSetId,
      A,
      'ok',
    );
    assert.equal((await k2.head()).entries.length, 0);
    await pool!.query('UPDATE kb_records SET body = replace(body, \'"v"\', \'"w"\') WHERE tenant = $1 AND id = $2', [t1, c.id]);
    await assert.rejects(k1.records(s.stateId), IntegrityError);
  });
});

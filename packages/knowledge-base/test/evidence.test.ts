import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  KnowledgeBase,
  SqlKnowledgeStore,
  sqliteDriver,
  executableKnowledge,
  mapEiAssertions,
  normaliseQuote,
  quoteHashOf,
  resolveRecordEvidence,
  type ClaimRecord,
  type EiAssertionLike,
  type EvidenceRef,
  type EvidenceSourcePort,
  type SourceView,
} from '../src/index.js';

const A = { id: 'u-author', kind: 'user' };
const R = { id: 'u-reviewer', kind: 'user' };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const POLICY_PAGES = ['Refund policy. Refunds over 500 need a manager.', 'Shipping. Orders ship within 2 days.'];
const POLICY = sha(POLICY_PAGES.join('\f'));
const ALTERED = sha('altered');

/** A port over in-memory sources: a digest maps to a view; `altered` sources fail the re-hash. */
function port(extra: Record<string, SourceView> = {}): EvidenceSourcePort & { reads: number } {
  const views: Record<string, SourceView> = {
    [POLICY]: { name: 'policy.pdf', digestVerified: true, pageCount: 2, pageTexts: POLICY_PAGES },
    [ALTERED]: { name: 'old.pdf', digestVerified: false },
    ...extra,
  };
  const p = {
    reads: 0,
    async source(d: string) {
      p.reads++;
      return views[d];
    },
  };
  return p;
}

const ev = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  sourceDigestSha256: POLICY,
  sourceName: 'policy.pdf',
  locator: { pages: [1] },
  method: { kind: 'source', name: 'test', version: '1' },
  ...over,
});

let n = 0;
function claim(text: string, evidence: EvidenceRef[], over: Partial<ClaimRecord> = {}): ClaimRecord {
  n++;
  return {
    kind: 'claim',
    id: `clm_${n.toString(16).padStart(24, '0')}`,
    tenantId: 't1',
    type: 'xo:heuristic',
    subject: { literal: `s${n}` },
    predicate: 'xo:heuristic',
    object: { value: text },
    polarity: 'positive',
    authority: { level: 'source', basis: 'stated in policy.pdf' },
    text,
    evidence,
    derivation: 'source',
    confidence: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 0, 1) + (clock += 1000)).toISOString();
async function kb(): Promise<KnowledgeBase> {
  const dir = await mkdtemp(join(tmpdir(), 'bkb-ev-'));
  return new KnowledgeBase(await SqlKnowledgeStore.open(await sqliteDriver(join(dir, 'k.sqlite')), 't1', { ownsDriver: true }), now);
}

describe('UW-4a evidence resolver', () => {
  it('normalises quotes the same way it hashes them', () => {
    assert.equal(normaliseQuote('  Refunds — OVER 500!  '), 'refunds over 500');
    assert.equal(quoteHashOf('Refunds over 500'), quoteHashOf('refunds, over 500.'));
    assert.notEqual(quoteHashOf('Refunds over 500'), quoteHashOf('Refunds over 50'));
  });

  it('resolves evidence whose source, page and quote stand', async () => {
    const r = await resolveRecordEvidence(
      claim('Refunds over 500 need a manager', [ev({ quote: 'Refunds over 500 need a manager.' })]),
      port(),
    );
    assert.equal(r.resolved, true);
    assert.equal(r.evidence[0]!.status, 'resolved');
    assert.equal(r.evidence[0]!.words, 'found');
  });

  it('resolves a quote held only by hash against the record’s own words', async () => {
    const words = 'Orders ship within 2 days';
    const ok = await resolveRecordEvidence(claim(words, [ev({ locator: { pages: [2] }, quoteHash: quoteHashOf(words) })]), port());
    assert.equal(ok.evidence[0]!.status, 'resolved');
    const wrongHash = await resolveRecordEvidence(claim(words, [ev({ locator: { pages: [2] }, quoteHash: quoteHashOf('other') })]), port());
    assert.equal(wrongHash.evidence[0]!.status, 'quote_hash_mismatch');
  });

  it('refuses each way evidence can stop standing, and says why', async () => {
    const p = port({
      [sha('scan')]: { name: 'scan.pdf', digestVerified: true, pageCount: 3 },
      // Page 2 is a scan inside a text PDF: a quote on it cannot be re-read, so it is unverifiable, not missing.
      [sha('half')]: { name: 'half.pdf', digestVerified: true, pageCount: 2, pageTexts: ['text page', ''], unreadablePages: [2] },
    });
    const cases: [EvidenceRef, string][] = [
      [ev({ sourceDigestSha256: sha('gone') }), 'source_missing'],
      [ev({ sourceDigestSha256: ALTERED, sourceName: 'old.pdf' }), 'source_altered'],
      [ev({ locator: { pages: [7] } }), 'locator_out_of_range'],
      [ev({ locator: { pages: [2] }, quote: 'Refunds over 500 need a manager' }), 'quote_not_found'],
      [ev({ sourceDigestSha256: sha('scan'), sourceName: 'scan.pdf', quote: 'anything' }), 'quote_unverifiable'],
      [ev({ sourceDigestSha256: sha('half'), sourceName: 'half.pdf', locator: { pages: [2] }, quote: 'anything' }), 'quote_unverifiable'],
    ];
    for (const [e, status] of cases) {
      const r = await resolveRecordEvidence(claim('Refunds over 500 need a manager', [e]), p);
      assert.equal(r.resolved, false, status);
      assert.equal(r.evidence[0]!.status, status);
      assert.ok(r.evidence[0]!.detail.length > 0);
    }
  });

  it('UW-12a: a retired version (replaced, or gone from its connected folder) no longer stands, and says which', async () => {
    const p = port({
      [sha('v1')]: { name: 'rates.xlsx', digestVerified: true, retired: { at: '2026-11-16T10:00:00.000Z', reason: 'changed' } },
      [sha('gone')]: { name: 'old.pdf', digestVerified: true, retired: { at: '2026-11-16T10:00:00.000Z', reason: 'removed' } },
    });
    const replaced = await resolveRecordEvidence(claim('rate', [ev({ sourceDigestSha256: sha('v1'), sourceName: 'rates.xlsx' })]), p);
    assert.equal(replaced.resolved, false);
    assert.equal(replaced.evidence[0]!.status, 'source_retired');
    assert.match(replaced.evidence[0]!.detail, /replaced on 2026-11-16: review it against the current file/);
    const removed = await resolveRecordEvidence(claim('rate', [ev({ sourceDigestSha256: sha('gone'), sourceName: 'old.pdf' })]), p);
    assert.match(removed.evidence[0]!.detail, /no longer in its connected folder/);
  });

  it('checks workbook sheets and rows', async () => {
    const book = sha('book');
    const p = port({ [book]: { name: 'rates.xlsx', digestVerified: true, sheets: { Rates: { rows: 10 } } } });
    const at = (sheet: string, row: number) =>
      resolveRecordEvidence(claim('rate', [ev({ sourceDigestSha256: book, sourceName: 'rates.xlsx', locator: { sheet, row } })]), p);
    assert.equal((await at('Rates', 4)).evidence[0]!.status, 'resolved');
    assert.equal((await at('Rates', 11)).evidence[0]!.status, 'locator_out_of_range');
    assert.equal((await at('Other', 1)).evidence[0]!.status, 'locator_out_of_range');
  });

  it('a record without evidence resolves only when a person asserted it', async () => {
    assert.equal((await resolveRecordEvidence(claim('x', [], { derivation: 'human' }), port())).resolved, true);
    assert.equal((await resolveRecordEvidence(claim('x', [], { derivation: 'model' }), port())).resolved, false);
  });

  it('reads each source once per resolution', async () => {
    const p = port();
    const cache = new Map();
    await resolveRecordEvidence(claim('a', [ev(), ev(), ev()]), p, cache);
    await resolveRecordEvidence(claim('b', [ev()]), p, cache);
    assert.equal(p.reads, 1);
  });
});

describe('UW-4a executable-use gate (UAC-12)', () => {
  it('only approved, resolvable, unconflicted knowledge may feed execution', async () => {
    const k = await kb();
    const good = claim('Refunds over 500 need a manager', [ev({ quote: 'Refunds over 500 need a manager' })]);
    const stale = claim('Refunds need a form', [ev({ sourceDigestSha256: ALTERED, sourceName: 'old.pdf' })]);
    const pending = claim('Orders ship within 2 days', [ev({ locator: { pages: [2] } })]);
    const s1 = await k.approve(
      (await k.propose({
        operations: [
          { op: 'add', record: good },
          { op: 'add', record: stale },
        ],
        origin: { kind: 'manual', ref: 'a' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    // Proposed but never approved: not in the state at all.
    await k.propose({ operations: [{ op: 'add', record: pending }], origin: { kind: 'manual', ref: 'p' }, proposedBy: A });

    const verdict = await executableKnowledge(k, s1.stateId, port(), { recordIds: [good.id, stale.id, pending.id] });
    assert.deepEqual(verdict.executable, [good.id]);
    const why = Object.fromEntries(verdict.refused.map((v) => [v.recordId, v.reasons.join(' | ')]));
    assert.match(why[stale.id]!, /evidence does not resolve: old\.pdf: the stored bytes no longer match/);
    assert.match(why[pending.id]!, /is not in knowledge state/);
  });

  it('refuses superseded claims, claims in an unresolved conflict, and the loser of a ruling', async () => {
    const k = await kb();
    const a = claim('Refunds over 500 need a manager', [ev()], { subject: { literal: 'refund' }, object: { value: 'deny' } });
    const b = claim('Refunds over 500 need a manager', [ev()], {
      subject: { literal: 'refund' },
      object: { value: 'approve' },
      authority: { level: 'reviewed', basis: 'memo' },
    });
    const s1 = await k.approve(
      (await k.propose({
        operations: [
          { op: 'add', record: a },
          { op: 'add', record: b },
        ],
        origin: { kind: 'manual', ref: 'c' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    assert.equal(s1.conflicts[0]!.status, 'unresolved');
    let v = await executableKnowledge(k, s1.stateId, port());
    assert.deepEqual(v.executable, []);
    for (const r of v.refused) assert.match(r.reasons.join(), /unresolved conflict/);

    const s2 = await k.approve(
      (await k.propose({
        operations: [{ op: 'resolve-conflict', conflictId: s1.conflicts[0]!.id, prevailing: a.id, rationale: 'policy wins' }],
        origin: { kind: 'manual', ref: 'r' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    v = await executableKnowledge(k, s2.stateId, port());
    assert.deepEqual(v.executable, [a.id]);
    assert.match(v.refused[0]!.reasons.join(), /resolved in favour of/);

    const s3 = await k.approve(
      (await k.propose({
        operations: [{ op: 'supersede', recordId: a.id, by: claim('Refunds over 500 need a manager', [ev()]) }],
        origin: { kind: 'manual', ref: 's' },
        proposedBy: A,
      }))!.changeSetId,
      R,
      'ok',
    );
    v = await executableKnowledge(k, s3.stateId, port(), { recordIds: [a.id] });
    assert.equal(v.refused[0]!.lifecycle, 'superseded');
    assert.match(v.refused[0]!.reasons.join(), /superseded, not approved/);
  });
});

describe('UW-4a EI → BKB mapping (ADR 0012 decision 7)', () => {
  const person = (v: string) => ({ kind: 'person', identifiers: [{ scheme: 'email', value: v }] });
  const base = (id: string, digest: string, status?: EiAssertionLike['epistemicStatus']): Omit<EiAssertionLike, 'candidate'> => ({
    id,
    support: { sourceId: 'src_hr', resourceDigest: `sha256:${digest}`, observedAt: '2026-02-01T00:00:00.000Z' },
    derivation: { deriverId: 'ei.hr', deriverVersion: '1' },
    ...(status !== undefined ? { epistemicStatus: status } : {}),
  });
  const ctx = { tenantId: 't1', recordedAt: '2026-02-02T00:00:00.000Z', sourceName: (s: string) => `${s}.json` };

  it('maps observed claims, corroborated inferences and hypotheses; drops unknowns', () => {
    const d1 = sha('one');
    const d2 = sha('two');
    const out = mapEiAssertions(
      [
        {
          ...base('a1', d1),
          candidate: { type: 'claim', kind: 'fact', subject: person('ana@x'), predicate: 'title', value: 'CFO', origin: 'observed' },
        },
        {
          ...base('a2', d1, 'corroborated_inference'),
          candidate: { type: 'relationship', relation: 'manages', from: person('ana@x'), to: person('bo@x'), origin: 'inferred' },
        },
        {
          ...base('a3', d2, 'corroborated_inference'),
          candidate: { type: 'relationship', relation: 'manages', from: person('ana@x'), to: person('bo@x'), origin: 'inferred' },
        },
        {
          ...base('a4', d1, 'corroborated_inference'),
          candidate: {
            type: 'claim',
            kind: 'responsibility',
            subject: person('bo@x'),
            predicate: 'owns',
            value: 'payroll',
            origin: 'inferred',
          },
        },
        { ...base('a5', d1, 'unknown'), candidate: { type: 'entity', ref: person('cy@x') } },
        { ...base('a6', 'not-a-digest'), candidate: { type: 'entity', ref: person('dee@x') } },
      ],
      ctx,
    );
    const claimTitle = out.records.find((r) => r.kind === 'claim') as ClaimRecord;
    assert.equal(claimTitle.origin, 'observed');
    assert.equal(claimTitle.predicate, 'xo:fact.title');
    assert.equal(claimTitle.evidence[0]!.observedAt, '2026-02-01T00:00:00.000Z');
    const manages = out.records.find((r) => r.kind === 'relationship')!;
    assert.equal(manages.type, 'xo:relation.manages');
    assert.equal(manages.evidence.length, 2, 'two independent sources corroborate it');
    assert.equal(out.hypotheses.length, 1, 'an inference from one source is a hypothesis');
    assert.equal((out.hypotheses[0] as ClaimRecord).origin, 'inferred');
    assert.deepEqual(
      out.skipped.map((s) => s.assertionId),
      ['a5', 'a6'],
    );
    assert.equal(out.records.filter((r) => r.kind === 'entity').length, 2);
  });

  it('is deterministic: the same assertions give the same record ids and digests', () => {
    const d1 = sha('one');
    const as: EiAssertionLike[] = [
      {
        ...base('a1', d1),
        candidate: { type: 'claim', kind: 'fact', subject: person('ana@x'), predicate: 'title', value: 'CFO', origin: 'observed' },
      },
    ];
    assert.deepEqual(mapEiAssertions(as, ctx), mapEiAssertions([...as].reverse(), ctx));
  });

  it('mapped records pass change-set validation and approve into a state', async () => {
    const k = await kb();
    const out = mapEiAssertions(
      [
        {
          ...base('a1', sha('one')),
          candidate: { type: 'claim', kind: 'fact', subject: person('ana@x'), predicate: 'title', value: 'CFO', origin: 'observed' },
        },
      ],
      ctx,
    );
    const cs = await k.propose({
      operations: out.records.map((record) => ({ op: 'add' as const, record })),
      origin: { kind: 'manual', ref: 'ei' },
      proposedBy: A,
    });
    assert.deepEqual(
      cs!.findings.filter((f) => f.severity === 'error'),
      [],
    );
    const s = await k.approve(cs!.changeSetId, R, 'ok');
    assert.equal(s.entries.length, 2);
  });
});

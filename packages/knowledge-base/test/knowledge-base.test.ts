import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { KnowledgeError } from '../src/index.js';
import {
  FsKnowledgeStore,
  SqlKnowledgeStore,
  sqliteDriver,
  KnowledgeBase,
  IntegrityError,
  makePackArtifact,
  resolvePackDependencies,
  detectConflicts,
  reconcileXoirGraph,
  type ClaimRecord,
  type DomainPackManifest,
  type EntityRecord,
  type EvidenceRef,
  type XoirGraphView,
} from '../src/index.js';

const A = { id: 'u-author', kind: 'user' };
const R = { id: 'u-reviewer', kind: 'user' };
const SRC = 'a'.repeat(64);
const ev = (name = 'policy.md', section = ['Refunds']): EvidenceRef[] => [
  { sourceDigestSha256: SRC, sourceName: name, locator: { section }, method: { kind: 'source', name: 'test', version: '1' } },
];

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 0, 1) + (clock += 1000)).toISOString();

type StoreKind = 'file' | 'sqlite';
/** The BKB conformance suite runs against every store: the same behaviour on files and on a database. */
const STORES: readonly StoreKind[] = ['file', 'sqlite'];

function makeKb(store: StoreKind) {
  return async (tenant = 't1', root?: string): Promise<{ kb: KnowledgeBase; root: string }> => {
    const dir = root ?? (await mkdtemp(join(tmpdir(), 'bkb-')));
    if (store === 'file') return { kb: new KnowledgeBase(await FsKnowledgeStore.open(dir, tenant), now), root: dir };
    const driver = await sqliteDriver(join(dir, 'knowledge.sqlite'));
    return { kb: new KnowledgeBase(await SqlKnowledgeStore.open(driver, tenant, { ownsDriver: true }), now), root: dir };
  };
}

function entity(tenant: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord {
  return {
    kind: 'entity',
    id: `ent_${Buffer.from(tenant + name)
      .toString('hex')
      .padEnd(24, '0')
      .slice(0, 24)}`,
    tenantId: tenant,
    type: 'xo:concept.organization',
    canonicalName: name,
    aliases: [],
    identifiers: [],
    attributes: {},
    evidence: ev(),
    derivation: 'source',
    confidence: 0.9,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function claim(tenant: string, id: string, subject: string, value: string, extra: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    kind: 'claim',
    id,
    tenantId: tenant,
    type: 'xo:heuristic',
    subject: { literal: subject },
    predicate: 'xo:heuristic',
    object: { value },
    polarity: 'positive',
    authority: { level: 'source', basis: 'stated in policy.md' },
    text: `${subject}: ${value}`,
    evidence: ev(),
    derivation: 'source',
    confidence: 0.9,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const hex = (n: number): string => n.toString(16).padStart(24, '0');

function pack(
  ns: string,
  version = '1.0.0',
  extra: Partial<DomainPackManifest['contributions']> = {},
): ReturnType<typeof makePackArtifact> {
  return makePackArtifact({
    schema: 'xo.domain-pack.v1',
    packId: `pack.${ns}`,
    namespace: ns,
    version,
    compatibility: { core: '1' },
    dependencies: [],
    publisher: { id: 'pub', name: 'Publisher' },
    contributions: {
      entityTypes: [
        {
          name: 'Account',
          schema: { type: 'object', properties: { tier: { type: 'string', enum: ['gold', 'silver'] } }, required: ['tier'] },
        },
      ],
      predicates: [{ name: 'limit', schema: { type: 'number' } }],
      relationshipTypes: [{ name: 'ownedBy' }],
      ...extra,
    },
  });
}

for (const STORE of STORES) {
  const kb = makeKb(STORE);
  const fileOnly = { skip: STORE !== 'file' ? 'file layout specific' : false };
  describe(`[${STORE}] @xo/knowledge-base: change sets and states`, () => {
    it('nothing reaches the active state without approval; approval creates an immutable, verifiable state', async () => {
      const { kb: k } = await kb();
      const root = await k.head();
      assert.equal(root.entries.length, 0);
      const cs = await k.propose({
        operations: [{ op: 'add', record: claim('t1', `clm_${hex(1)}`, 'refund > 500', 'deny') }],
        origin: { kind: 'manual', ref: 'test' },
        proposedBy: A,
      });
      assert.ok(cs);
      assert.equal((await k.head()).stateId, root.stateId, 'proposing changes nothing');
      const s1 = await k.approve(cs.changeSetId, R, 'checked');
      assert.equal((await k.head()).stateId, s1.stateId);
      assert.deepEqual(await k.verifyState(s1.stateId, new Set([SRC])), []);
      assert.equal((await k.changeSet(cs.changeSetId)).status, 'approved');
      await assert.rejects(k.approve(cs.changeSetId, R, 'again'), (e: KnowledgeError) => e.code === 'already_decided');
    });

    it('a rejected change set never enters a state; a stale one must be re-proposed', async () => {
      const { kb: k } = await kb();
      const a = await k.propose({
        operations: [{ op: 'add', record: claim('t1', `clm_${hex(2)}`, 'x', '1') }],
        origin: { kind: 'manual', ref: 'a' },
        proposedBy: A,
      });
      const b = await k.propose({
        operations: [{ op: 'add', record: claim('t1', `clm_${hex(3)}`, 'y', '2') }],
        origin: { kind: 'manual', ref: 'b' },
        proposedBy: A,
      });
      await k.reject(a!.changeSetId, R, 'wrong');
      assert.equal((await k.changeSet(a!.changeSetId)).status, 'rejected');
      await k.approve(b!.changeSetId, R, 'ok');
      const c = await k.propose({
        operations: [{ op: 'add', record: claim('t1', `clm_${hex(4)}`, 'z', '3') }],
        origin: { kind: 'manual', ref: 'c' },
        proposedBy: A,
      });
      const d = await k.propose({
        operations: [{ op: 'add', record: claim('t1', `clm_${hex(5)}`, 'w', '4') }],
        origin: { kind: 'manual', ref: 'd' },
        proposedBy: A,
      });
      await k.approve(c!.changeSetId, R, 'ok');
      await assert.rejects(k.approve(d!.changeSetId, R, 'ok'), (e: KnowledgeError) => e.code === 'stale_base');
      const ids = (await k.records((await k.head()).stateId)).map((x) => x.record.id);
      assert.ok(!ids.includes(`clm_${hex(2)}`));
    });

    it('change sets with error findings cannot be approved (no evidence, dangling, cross-tenant)', async () => {
      const { kb: k } = await kb();
      const bad = await k.propose({
        operations: [
          { op: 'add', record: claim('t1', `clm_${hex(6)}`, 'x', '1', { evidence: [] }) },
          {
            op: 'add',
            record: {
              kind: 'relationship',
              id: `rel_${hex(7)}`,
              tenantId: 't1',
              type: 'xo:edge.REQUIRES',
              from: `ent_${hex(8)}`,
              to: `ent_${hex(9)}`,
              directed: true,
              evidence: ev(),
              derivation: 'source',
              confidence: 1,
              recordedAt: '2026-01-01T00:00:00.000Z',
            },
          },
          { op: 'add', record: claim('t2', `clm_${hex(10)}`, 'x', '1') },
        ],
        origin: { kind: 'manual', ref: 'bad' },
        proposedBy: A,
      });
      const codes = bad!.findings.map((f) => f.code).sort();
      assert.deepEqual(codes, ['cross-tenant', 'dangling-relationship', 'no-evidence']);
      await assert.rejects(k.approve(bad!.changeSetId, R, 'x'), (e: KnowledgeError) => e.code === 'invalid_change_set');
    });

    it('pinned states keep their content after later changes; supersede keeps history', async () => {
      const { kb: k } = await kb();
      const c1 = claim('t1', `clm_${hex(11)}`, 'limit', '500');
      const s1 = await k.approve(
        (await k.propose({ operations: [{ op: 'add', record: c1 }], origin: { kind: 'manual', ref: '1' }, proposedBy: A }))!.changeSetId,
        R,
        'ok',
      );
      const c2 = claim('t1', `clm_${hex(12)}`, 'limit', '700');
      const s2 = await k.approve(
        (await k.propose({
          operations: [{ op: 'supersede', recordId: c1.id, by: c2 }],
          origin: { kind: 'manual', ref: '2' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      assert.deepEqual(
        (await k.records(s1.stateId)).map((x) => x.record.id),
        [c1.id],
      );
      assert.deepEqual(
        (await k.records(s2.stateId)).map((x) => x.record.id),
        [c2.id],
      );
      assert.deepEqual(
        (await k.records(s2.stateId, { lifecycle: 'superseded' })).map((x) => x.record.id),
        [c1.id],
      );
      assert.equal(s2.parentStateId, s1.stateId);
      assert.equal(
        (await k.search(s1.stateId, 'limit 700')).find((h) => h.recordId === c2.id),
        undefined,
        'a pinned search never sees later knowledge',
      );
    });
  });

  describe(`[${STORE}] @xo/knowledge-base: conflicts, entities and retrieval`, () => {
    it('competing claims are both kept and the conflict is recorded; precedence resolves it; a ruling resolves it', async () => {
      const { kb: k } = await kb();
      const a = claim('t1', `clm_${hex(20)}`, 'refund over 500', 'deny');
      const b = claim('t1', `clm_${hex(21)}`, 'refund over 500', 'approve', { authority: { level: 'reviewed', basis: 'manager memo' } });
      const s = await k.approve(
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
      assert.equal(s.conflicts.length, 1);
      assert.equal(s.conflicts[0]!.status, 'unresolved');
      assert.equal((await k.records(s.stateId, { kind: 'claim' })).length, 2, 'both claims are kept');
      const byPolicy = detectConflicts([a, b], { version: 'p1', order: ['source', 'reviewed', 'authoritative'] });
      assert.equal(byPolicy[0]!.status, 'resolved-by-precedence');
      assert.equal(byPolicy[0]!.prevailing, b.id);
      const s2 = await k.approve(
        (await k.propose({
          operations: [{ op: 'resolve-conflict', conflictId: s.conflicts[0]!.id, prevailing: a.id, rationale: 'policy wins' }],
          origin: { kind: 'manual', ref: 'r' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      assert.equal(s2.conflicts[0]!.status, 'resolved-by-ruling');
      assert.equal(s2.conflicts[0]!.prevailing, a.id);
      assert.equal(s2.conflicts[0]!.resolution!.by, R.id);
    });

    it('claims valid at different times do not conflict', () => {
      const a = claim('t1', `clm_${hex(22)}`, 's', '1', { validity: { from: '2024-01-01', to: '2024-12-31' } });
      const b = claim('t1', `clm_${hex(23)}`, 's', '2', { validity: { from: '2025-01-01' } });
      assert.deepEqual(detectConflicts([a, b]), []);
    });

    it('entity resolution links only on an identifier or a single exact name; similar names are candidates, never merged', async () => {
      const { kb: k } = await kb();
      const acme = entity('t1', 'Acme Corp', { identifiers: [{ scheme: 'duns', value: '123' }], aliases: ['ACME'] });
      const acme2 = entity('t1', 'Acme Corporation Ltd');
      const s = await k.approve(
        (await k.propose({
          operations: [
            { op: 'add', record: acme },
            { op: 'add', record: acme2 },
          ],
          origin: { kind: 'manual', ref: 'e' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      assert.deepEqual(await k.resolveEntity(s.stateId, { name: 'whatever', identifiers: [{ scheme: 'duns', value: '123' }] }), {
        status: 'linked',
        entityId: acme.id,
        method: 'identifier',
        candidates: [],
      });
      assert.equal((await k.resolveEntity(s.stateId, { name: 'acme' })).entityId, acme.id);
      const fuzzy = await k.resolveEntity(s.stateId, { name: 'Acme Corporation' });
      assert.equal(fuzzy.status, 'unresolved');
      assert.ok(fuzzy.candidates.length >= 1);
      assert.equal((await k.records(s.stateId, { kind: 'entity' })).length, 2);
    });

    it('search is BM25 over the pinned state and returns evidence and authority', async () => {
      const { kb: k } = await kb();
      const s = await k.approve(
        (await k.propose({
          operations: [
            { op: 'add', record: claim('t1', `clm_${hex(30)}`, 'refund exceeds 500', 'deny the refund') },
            { op: 'add', record: claim('t1', `clm_${hex(31)}`, 'invoice is overdue', 'send a reminder') },
          ],
          origin: { kind: 'manual', ref: 's' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      const hits = await k.search(s.stateId, 'refund');
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.recordId, `clm_${hex(30)}`);
      assert.equal(hits[0]!.authority!.level, 'source');
      assert.equal(hits[0]!.evidence[0]!.sourceName, 'policy.md');
      assert.equal(hits[0]!.stateId, s.stateId);
    });
  });

  describe(`[${STORE}] @xo/knowledge-base: tenancy and integrity`, () => {
    it('tenants are isolated: another tenant sees nothing and cannot write into this one', async () => {
      const { kb: k1, root } = await kb('t1');
      const { kb: k2 } = await kb('t2', root);
      await k1.approve(
        (await k1.propose({
          operations: [{ op: 'add', record: claim('t1', `clm_${hex(40)}`, 'secret', 'v') }],
          origin: { kind: 'manual', ref: 't' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      assert.equal((await k2.head()).entries.length, 0);
      assert.deepEqual(await k2.search((await k2.head()).stateId, 'secret'), []);
      await assert.rejects(k2.store.putRecord(claim('t1', `clm_${hex(41)}`, 'x', 'y')), IntegrityError);
      assert.notEqual(k1.rootState().stateId, k2.rootState().stateId);
    });

    it('tampering with a record, a state or the event log is detected', fileOnly, async () => {
      const { kb: k, root } = await kb();
      const c = claim('t1', `clm_${hex(42)}`, 'x', 'y');
      const s = await k.approve(
        (await k.propose({ operations: [{ op: 'add', record: c }], origin: { kind: 'manual', ref: 'i' }, proposedBy: A }))!.changeSetId,
        R,
        'ok',
      );
      const recPath = join(root, 't1', 'records', `${c.id}.json`);
      await writeFile(recPath, JSON.stringify({ ...c, text: 'changed' }));
      assert.ok((await k.verifyState(s.stateId)).some((f) => f.code === 'record-digest'));
      await assert.rejects(k.records(s.stateId), (e: KnowledgeError) => e.code === 'integrity');
      const statePath = join(root, 't1', 'states', `${s.stateId}.json`);
      await writeFile(statePath, JSON.stringify({ ...s, entries: [] }));
      assert.ok((await k.verifyState(s.stateId)).some((f) => f.code === 'state-digest'));
      const log = join(root, 't1', 'events.jsonl');
      const lines = (await readFile(log, 'utf8')).trim().split('\n');
      lines[0] = lines[0]!.replace('"manual"', '"manuaL"').replace('change-set.proposed', 'change-set.Proposed');
      await writeFile(log, `${lines.join('\n')}\n`);
      await assert.rejects(k.head(), IntegrityError);
    });

    it('flags evidence that cites an unknown source version', async () => {
      const { kb: k } = await kb();
      const s = await k.approve(
        (await k.propose({
          operations: [{ op: 'add', record: claim('t1', `clm_${hex(43)}`, 'x', 'y') }],
          origin: { kind: 'manual', ref: 'o' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      assert.ok((await k.verifyState(s.stateId, new Set(['b'.repeat(64)]))).some((f) => f.code === 'orphan-evidence'));
    });

    it('a person may assert without a source; nothing else may', async () => {
      const { kb: k } = await kb();
      const cs = await k.propose({
        operations: [
          {
            op: 'add',
            record: claim('t1', `clm_${hex(44)}`, 'x', 'y', {
              evidence: [],
              derivation: 'human',
              authority: { level: 'authoritative', basis: 'policy owner' },
            }),
          },
        ],
        origin: { kind: 'manual', ref: 'h' },
        proposedBy: A,
      });
      assert.deepEqual(cs!.findings, []);
    });
  });

  describe(`[${STORE}] @xo/knowledge-base: domain packs`, () => {
    it('two synthetic packs validate their own types; an unknown namespace is kept but unsupported', async () => {
      const { kb: k } = await kb();
      await k.installPack(pack('alpha'), A);
      await k.installPack(pack('beta'), A);
      const ok = entity('t1', 'Gold account', { type: 'alpha:Account', attributes: { tier: 'gold' } });
      const bad = entity('t1', 'Odd account', { type: 'beta:Account', attributes: { tier: 'bronze' } });
      const undeclared = claim('t1', `clm_${hex(50)}`, 's', 'v', { predicate: 'alpha:unknownPredicate', type: 'alpha:unknownPredicate' });
      const foreign = claim('t1', `clm_${hex(51)}`, 's', 'v', { predicate: 'gamma:limit', type: 'gamma:limit' });
      const cs = await k.propose({
        operations: [
          { op: 'add', record: ok },
          { op: 'add', record: bad },
          { op: 'add', record: undeclared },
          { op: 'add', record: foreign },
        ],
        origin: { kind: 'manual', ref: 'p' },
        proposedBy: A,
      });
      const by = (id: string): string[] => cs!.findings.filter((f) => f.ref === id).map((f) => `${f.severity}:${f.code}`);
      assert.deepEqual(by(ok.id), []);
      assert.deepEqual(by(bad.id), ['error:schema']);
      assert.deepEqual(by(undeclared.id), ['error:schema']);
      assert.deepEqual(by(foreign.id), ['warning:unsupported-namespace']);
      const good = await k.propose({
        operations: [
          { op: 'add', record: ok },
          { op: 'add', record: foreign },
        ],
        origin: { kind: 'manual', ref: 'p2' },
        proposedBy: A,
      });
      const s = await k.approve(good!.changeSetId, R, 'ok');
      assert.equal(s.entries.find((e) => e.id === foreign.id)!.interpretation, 'unsupported');
      assert.deepEqual(
        s.packBindings.map((b) => b.namespace),
        ['alpha', 'beta'],
      );
    });

    it('a second pack for an active namespace is refused; a tampered pack is refused', async () => {
      const { kb: k } = await kb();
      await k.installPack(pack('alpha'), A);
      await assert.rejects(k.installPack(pack('alpha', '2.0.0'), A), /already defined/);
      const p = pack('delta');
      await assert.rejects(k.installPack({ ...p, manifest: { ...p.manifest, version: '9.9.9' } }, A));
    });

    it('dependencies resolve by exact digest only', () => {
      const base = pack('base');
      const dependent = { packId: 'pack.base', namespace: 'base', version: '1.0.0', digest: base.digest };
      assert.equal(resolvePackDependencies([dependent], [base]).ok, true);
      assert.equal(resolvePackDependencies([{ ...dependent, digest: pack('base', '1.0.1').digest }], [base]).ok, false);
    });

    it('installed packs hold no tenant data', fileOnly, async () => {
      const { kb: k, root } = await kb();
      await k.installPack(pack('alpha'), A);
      await k.approve(
        (await k.propose({
          operations: [{ op: 'add', record: claim('t1', `clm_${hex(52)}`, 'tenant secret', 'v') }],
          origin: { kind: 'manual', ref: 'x' },
          proposedBy: A,
        }))!.changeSetId,
        R,
        'ok',
      );
      for (const f of await readdir(join(root, 't1', 'packs')))
        assert.ok(!(await readFile(join(root, 't1', 'packs', f), 'utf8')).includes('tenant secret'));
    });
  });

  describe(`[${STORE}] @xo/knowledge-base: XOIR reconciliation`, () => {
    const sources = new Map([['src_1', { name: 'policy.md', digestSha256: SRC }]]);
    const graph = (action: string): XoirGraphView => ({
      nodes: [
        {
          id: 'n1',
          kind: 'concept',
          properties: { definition: 'Acme Corp' },
          metadata: {
            subtype: 'organization',
            confidence: 0.9,
            sourceRefs: [{ documentPath: 'src_1', sectionPath: ['Refunds'], charOffsetRange: [0, 9] }],
          },
        },
        {
          id: 'n2',
          kind: 'heuristic',
          properties: { condition: 'the refund exceeds 500', action, modality: 'obligation' },
          metadata: { subtype: 'rule', confidence: 0.8, sourceRefs: [{ documentPath: 'src_1', sectionPath: ['Refunds'] }] },
        },
        { id: 'n3', kind: 'workflow_step', properties: {}, metadata: { sourceRefs: [{ documentPath: 'src_1' }] } },
        { id: 'n4', kind: 'fact', properties: { statement: 'orphan' }, metadata: { sourceRefs: [{ documentPath: 'unknown' }] } },
      ],
      edges: [{ id: 'e1', kind: 'APPLIES_TO', fromId: 'n2', toId: 'n1' }],
    });
    const ctx = {
      sources,
      origin: { kind: 'xoir-reconciliation' as const, ref: 'cmp_1' },
      proposedBy: A,
      recordedAt: '2026-01-01T00:00:00.000Z',
    };

    it('proposes a change set with a complete report; recompiling the same sources proposes nothing', async () => {
      const { kb: k } = await kb();
      const first = await reconcileXoirGraph(k, graph('deny the refund'), ctx);
      assert.equal(first.report.accepted.length, 3);
      assert.deepEqual(first.report.unsupported, ['n3 (workflow_step)']);
      assert.equal(first.report.rejected[0]!.ref, 'n4');
      assert.deepEqual(
        first.changeSet!.findings.filter((f) => f.severity === 'error'),
        [],
      );
      await k.approve(first.changeSet!.changeSetId, R, 'ok');
      const again = await reconcileXoirGraph(k, graph('deny the refund'), ctx);
      assert.equal(again.changeSet, undefined);
      assert.equal(again.report.accepted.length, 0);
      assert.equal(again.report.unchanged.length, 3);
    });

    it('a changed rule in the same place supersedes the old one instead of overwriting it', async () => {
      const { kb: k } = await kb();
      await k.approve((await reconcileXoirGraph(k, graph('deny the refund'), ctx)).changeSet!.changeSetId, R, 'ok');
      const next = await reconcileXoirGraph(k, graph('escalate the refund'), ctx);
      assert.equal(next.report.updated.length, 1);
      assert.equal(next.report.conflicting.length, 1);
      const s = await k.approve(next.changeSet!.changeSetId, R, 'ok');
      assert.equal((await k.records(s.stateId, { lifecycle: 'superseded' })).length, 1);
      assert.equal(s.conflicts.length, 0, 'a superseded claim no longer conflicts');
    });
  });
}

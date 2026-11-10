/**
 * C5 - END-TO-END ACCEPTANCE DEMONSTRATION (items 1-9).
 *
 * KIND OF TEST: OFFLINE CONTRACT tests. Four scripted organizational sources (HR directory, mail, project tool, policy documents) are
 * ingested through the REAL C4 `ingestSource` (real registry, framework enforcement, ledger, audit recorder, durable `EiStateStore`) and
 * derived by the REAL C5 service. No network, no credentials. Nothing here verifies any real provider (live Microsoft OAuth is UNVERIFIED).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  provenanceDigestOf,
  queryKnowledge,
  reviewKnowledge,
  KnowledgeModel,
  revokeSourceEvidence,
  verifyProvenance,
  deriveKnowledge,
  type ClaimItem,
  type ConflictItem,
  type EntityItem,
  type RelationshipItem,
} from '../src/index.js';
import { withSandbox } from './helpers.js';
import { knowledgeEnv, OrgProvider, authenticated, type KnowledgeEnv } from './support/knowledge-env.js';
import { ANITA, HR, MAIL, PATHS, PM, POLICY, PRIYA, load, loadAll, seedOrg } from './support/org-fixtures.js';

const setup = async (base: string, opts: { provider?: OrgProvider } = {}): Promise<KnowledgeEnv> => {
  const provider = opts.provider ?? seedOrg(new OrgProvider());
  return knowledgeEnv(base, { provider, paths: PATHS });
};

const q = async <T>(env: KnowledgeEnv, query: Parameters<typeof queryKnowledge>[1], ctx = env.ctx): Promise<readonly T[]> => {
  const r = await queryKnowledge(env.model, query, ctx);
  assert.ok(r.ok, `query should succeed: ${r.ok ? '' : r.error.code}`);
  return r.ok ? (r.value.items as readonly T[]) : [];
};
const priyaId = async (env: KnowledgeEnv, ctx = env.ctx): Promise<string> => {
  const ents = await q<EntityItem>(
    env,
    { select: 'entities', entity: { kind: 'person', identifier: { scheme: 'email', value: 'priya@acme.test' } } },
    ctx,
  );
  assert.equal(ents.length, 1);
  return (ents[0] as EntityItem).id;
};

test('(1) SAME ENTITY ACROSS SOURCES: HR, mail and the project tool describe one person; the merge basis is recorded; no duplicate', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const people = await q<EntityItem>(env, { select: 'entities', entityKind: 'person' });
    const priyas = people.filter((e) => e.identifiers.includes('person|email:priya@acme.test'));
    assert.equal(priyas.length, 1, 'one entity, not one per source');
    const priya = priyas[0] as EntityItem;
    assert.ok(priya.identifiers.includes('person|employee_id:E100'));
    assert.ok(priya.identifiers.includes('person|email:priya@acme.test'));
    assert.ok(
      priya.merges.some((m) => m.kind === 'co_listed_identifiers' && m.evidenceIds.length > 0),
      'merge basis: HR lists both identifiers',
    );
    assert.ok(
      priya.merges.some((m) => m.kind === 'shared_identifier'),
      'merge basis: the same email appears in several records',
    );
    assert.ok(priya.confidence.corroboration >= 3, 'HR + mail + PM are independent sources');
    // The mail/PM mentions carry only the email; they resolved through the HR record. Raj likewise.
    assert.equal(people.filter((e) => e.identifiers.includes('person|email:raj@acme.test')).length, 1);
    // Looking up by ANY identifier or by the entity's old (alias) id yields the same entity.
    const byEmpId = await q<EntityItem>(env, {
      select: 'entities',
      entity: { kind: 'person', identifier: { scheme: 'employee_id', value: 'E100' } },
    });
    assert.equal(byEmpId[0]?.id, priya.id);
    assert.ok(priya.aliases.length >= 1);
    const byAlias = await q<EntityItem>(env, { select: 'entities', entity: { id: priya.aliases[0] as string } });
    assert.equal(byAlias[0]?.id, priya.id);
    await env.store.close();
  });
});

test('(2) RELATIONSHIPS: typed, directional, provenance-carrying edges across sources', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const priya = await priyaId(env);
    const rels = await q<RelationshipItem>(env, { select: 'relationships', entity: { id: priya } });
    const kinds = new Set(rels.map((r) => `${r.relation}:${r.origin}`));
    assert.ok(kinds.has('belongs_to:observed'), 'priya belongs_to FIN (HR)');
    assert.ok(kinds.has('owns:observed'), 'priya owns PRJ-ATLAS (PM tool, identified by email only)');
    assert.ok(kinds.has('manages:observed'), 'anita manages priya (HR)');
    const owns = rels.find((r) => r.relation === 'owns') as RelationshipItem;
    assert.equal(owns.from, priya, 'direction: owner -> project');
    assert.equal(owns.xoirEdge, 'OWNED_BY', 'mapped onto the existing XOIR edge vocabulary (inverse)');
    assert.ok(owns.provenance.support.length >= 1);
    const governs = await q<RelationshipItem>(env, { select: 'relationships', relation: 'governs' });
    assert.equal(governs.length, 1);
    assert.equal(governs[0]?.xoirEdge, 'GOVERNS');
    const deps = await q<RelationshipItem>(env, { select: 'relationships', relation: 'depends_on' });
    assert.equal(deps.length, 1);
    await env.store.close();
  });
});

test('(3) FACTS: observed, stated and inferred stay distinct kinds; a source document is not the fact extracted from it', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const priya = await priyaId(env);
    const titles = await q<ClaimItem>(env, { select: 'claims', entity: { id: priya }, predicate: 'title' });
    assert.equal(titles[0]?.current?.value, 'Senior Finance Manager');
    assert.equal(titles[0]?.current?.origin, 'observed');
    const limits = await q<ClaimItem>(env, { select: 'claims', predicate: 'travel_limit' });
    assert.equal(limits[0]?.current?.origin, 'stated');
    assert.equal(limits[0]?.kind, 'policy');
    // Inference: raj<->PRJ-CORE appears only in ONE source (mail): flagged hypothesis, not a fact.
    const assoc = await q<RelationshipItem>(env, { select: 'relationships', relation: 'associated_with' });
    const single = assoc.filter((r) => r.confidence.corroboration === 1);
    const multi = assoc.filter((r) => r.confidence.corroboration >= 2);
    assert.ok(single.length >= 1 && multi.length >= 1);
    for (const r of single) {
      assert.equal(r.origin, 'inferred');
      assert.equal(r.confidence.status, 'candidate_hypothesis');
      assert.equal(r.confidence.promotedToFact, false, 'never promoted without >=2 independent sources');
    }
    for (const r of multi) {
      assert.equal(r.confidence.status, 'corroborated_inference');
      assert.equal(r.confidence.promotedToFact, true);
      assert.equal(r.origin, 'inferred', 'still an inference by origin; corroboration is recorded, not rewritten');
    }
    // Documents are separate items; the claim only REFERENCES them.
    const docs = await q<{ id: string; type: string }>(env, { select: 'documents' });
    assert.ok(docs.length >= 8 && docs.every((d) => d.type === 'document'));
    assert.ok(titles[0]?.current?.documents.every((d) => docs.some((x) => x.id === d)));
    await env.store.close();
  });
});

test('(4) PROVENANCE: every fact traces to evidence ids and a C4 provenance digest that verifies against the durable journal', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    const loaded = new Map<string, Awaited<ReturnType<typeof load>>>();
    for (const p of PATHS) loaded.set(p, await load(env, p));
    const claims = await q<ClaimItem>(env, { select: 'claims' });
    assert.ok(claims.length > 0);
    for (const c of claims) {
      const cur = c.current;
      if (cur === undefined) continue;
      assert.ok(cur.provenance.support.length >= 1, 'every fact has supporting evidence');
      assert.ok(
        cur.provenance.derivations.every(
          (d) => d.deriverId === 'xo.ei.structured-record' && d.principalId.length > 0 && d.derivationId.length > 0,
        ),
      );
      assert.ok(cur.provenance.lastVerifiedAt.startsWith('2026-10-30'));
      for (const s of cur.provenance.support) {
        assert.equal(env.ledger.isEligible(s.evidenceId as never), true);
        assert.match(s.contentHash, /^sha256:[0-9a-f]{64}$/);
        assert.equal(s.anchoring, 'journal_checkpoint');
      }
      const verdicts = verifyProvenance(env.model, env.ctx, cur.provenance.support);
      assert.ok(
        verdicts.every((v) => v.status === 'verified_against_journal'),
        JSON.stringify(verdicts),
      );
    }
    // The digest really is the durable checkpoint's, not something C5 invented.
    for (const [path, { ingestion }] of loaded) {
      assert.equal(env.store.checkpointOf(ingestion.binding)?.provenance, provenanceDigestOf(ingestion.items), path);
    }
    // After the checkpoint advances (catch-up), honest downgrade: the old batch is consistent but no longer the durable one.
    await env.ingest(HR);
    const hr = (await q<ClaimItem>(env, { select: 'claims', predicate: 'title' }))[0];
    const verdicts = verifyProvenance(env.model, env.ctx, hr?.current?.provenance.support ?? []);
    assert.ok(
      verdicts.every((v) => v.status === 'batch_superseded'),
      JSON.stringify(verdicts),
    );
    await env.store.close();
  });
});

test('(5) CONFLICT: 5 lakh vs 3 lakh approval limit - both claims, their evidence and timestamps are kept; nothing is picked; human review resolves it explicitly', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const conflicts = await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' });
    assert.equal(conflicts.length, 1);
    const c = conflicts[0] as ConflictItem;
    assert.equal(c.state, 'open');
    assert.deepEqual(c.resolution, { by: 'none', route: 'human_review' });
    assert.deepEqual(c.claims.map((x) => x.value).sort(), [300000, 500000]);
    for (const claim of c.claims) {
      assert.ok(claim.provenance.support.length >= 1);
      assert.match(claim.validity.validFrom, /^2026-10-30/);
      assert.equal(claim.origin, 'stated');
    }
    const [claim] = await q<ClaimItem>(env, { select: 'claims', predicate: 'approval_limit' });
    assert.equal(claim?.status, 'conflicted');
    assert.equal(claim?.current, undefined, 'no arbitrary pick');
    assert.equal(claim?.conflict, c.id);
    // Explicit, audited, attributed human decision.
    const decided = await reviewKnowledge(env.model, { action: 'resolve_conflict', conflictId: c.id, winner: 500000 }, env.ctx);
    assert.ok(decided.ok);
    const after = (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' }))[0] as ConflictItem;
    assert.equal(after.state, 'resolved');
    assert.equal(after.claims.length, 2, 'the losing claim is preserved');
    assert.equal(after.resolution.by, 'human');
    const resolved = (await q<ClaimItem>(env, { select: 'claims', predicate: 'approval_limit' }))[0];
    assert.equal(resolved?.current?.value, 500000);
    assert.ok(env.recorder.inner.events().some((e) => e.operation === 'review_knowledge' && e.outcome === 'completed'));
    await env.store.close();
  });
});

test('(6) TIME: what is true now vs previously, which source established the change, and as-of queries', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const priya = await priyaId(env);
    const at = async (asOf: string, predicate: string, entity?: string) =>
      (await q<ClaimItem>(env, { select: 'claims', predicate, asOf, ...(entity !== undefined ? { entity: { id: entity } } : {}) }))[0];
    assert.equal((await at('2025-06-01T00:00:00Z', 'title', priya))?.current?.value, 'Finance Manager');
    assert.equal((await at('2026-09-01T00:00:00Z', 'title', priya))?.current?.value, 'Senior Finance Manager');
    assert.equal(
      (await at('2023-01-01T00:00:00Z', 'title', priya))?.status,
      'unknown',
      'before any evidence: explicitly unknown, not guessed',
    );
    const now = await at('2026-10-30T00:00:00Z', 'title', priya);
    assert.deepEqual(
      now?.history.map((h) => h.value),
      ['Finance Manager', 'Senior Finance Manager'],
    );
    const change = now?.history[1];
    assert.equal(change?.validity.validFrom, '2026-06-01');
    assert.ok(change?.validity.establishedBy.startsWith('ev_'), 'the establishing evidence is recorded');
    assert.equal(now?.history[0]?.validity.validTo, '2026-06-01');
    // Effective-dated policy versions are history, not a conflict.
    assert.equal((await at('2025-06-01T00:00:00Z', 'travel_limit'))?.current?.value, 3000);
    assert.equal((await at('2026-06-01T00:00:00Z', 'travel_limit'))?.current?.value, 5000);
    assert.equal((await q<ConflictItem>(env, { select: 'conflicts', predicate: 'travel_limit' })).length, 0);
    // As-of for relationships: the same person's team edge only exists within its validity.
    const rels = await q<RelationshipItem>(env, {
      select: 'relationships',
      relation: 'belongs_to',
      entity: { id: priya },
      asOf: '2023-01-01T00:00:00Z',
    });
    assert.equal(rels.length, 0);
    await env.store.close();
  });
});

test('(7) ACCESS: source-level AND user-level restrictions; a caller never sees knowledge derived from evidence they cannot read', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const contractor = authenticated('contractor-1');
    const hrSource = env.sourceOf(HR) as string;
    env.policy.hide = (who, source) => who === 'contractor-1' && source === hrSource;
    const mine = env.as(contractor);
    // Admin sees everything.
    const adminTitles = await q<ClaimItem>(env, { select: 'claims', predicate: 'title' });
    assert.ok(adminTitles.length >= 1);
    // The contractor cannot read the HR directory: no titles, no employee ids, no HR-only people.
    assert.equal((await q<ClaimItem>(env, { select: 'claims', predicate: 'title' }, mine)).length, 0);
    const ents = await q<EntityItem>(env, { select: 'entities', entityKind: 'person' }, mine);
    for (const e of ents) {
      assert.ok(!e.identifiers.some((k) => k.includes('employee_id')), 'identifiers learned only from HR are not exposed');
      assert.ok(e.provenance.support.every((s) => s.sourceId !== hrSource));
    }
    // Mail + PM still resolve the person on the email they share, but the HR-based merge is not visible to this caller.
    assert.ok(ents.some((e) => e.identifiers.includes('person|email:priya@acme.test')));
    // The restriction is the CALL's own: the same environment, a different principal, still sees all of it.
    assert.ok((await q<ClaimItem>(env, { select: 'claims', predicate: 'title' })).length >= 1);
    // Per-resource restriction: hide only the 2026 HR record; the 2024 one stays readable.
    const hidden = env.model.assertions().find((a) => a.support.sourceId === hrSource && JSON.stringify(a.candidate).includes('Senior'));
    assert.ok(hidden);
    env.policy.hide = (who, _s, res) => who === 'contractor-1' && res === hidden?.support.resourceDigest;
    const partial = (await q<ClaimItem>(env, { select: 'claims', predicate: 'title' }, mine))[0];
    assert.deepEqual(
      partial?.history.map((h) => h.value),
      ['Finance Manager'],
    );
    // The hidden evidence leaks neither in values, counts nor conflicts.
    assert.ok(!JSON.stringify(partial).includes('Senior'));
    // The query decision itself is the caller's: no query authority -> denied, audited.
    env.policy.hide = () => false;
    env.policy.query = false;
    const denied = await queryKnowledge(env.model, { select: 'claims' }, mine);
    assert.ok(!denied.ok && denied.error.code !== 'EI_INTERNAL');
    assert.ok(env.recorder.inner.events().some((e) => e.operation === 'query_knowledge' && e.outcome === 'denied'));
    await env.store.close();
  });
});

test('(8) UPDATE: new information updates the model with no duplicates, and a replay changes nothing', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    const before = env.model.stateDigest();
    const sizeBefore = env.model.size;
    // Replay the same derivation: idempotent.
    const ids = env.ledger.idsOf(env.sourceOf(HR), ['released']);
    const replay = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, evidenceIds: ids },
      env.ctx,
    );
    assert.ok(replay.ok);
    assert.equal(replay.ok && replay.value.assertionsAdded, 0);
    assert.equal(env.model.stateDigest(), before);
    assert.equal(env.model.size, sizeBefore);
    // New information: Raj is promoted; the HR record for him changes (same resource, new content -> supersession).
    env.provider.set(HR, 'c1', {
      items: [
        {
          key: 'raj',
          record: {
            type: 'directory_entry',
            person: { kind: 'person', ids: { employee_id: 'E200', email: 'raj@acme.test' } },
            title: 'Senior Analyst',
            team: { kind: 'team', ids: { team_key: 'FIN' } },
            manager: { kind: 'person', ids: { employee_id: 'E100' } },
          },
        },
      ],
      next: 'c2',
    });
    env.provider.set(HR, 'c2', { items: [], next: 'c2' });
    const second = await env.ingest(HR, { maxBatches: 1 });
    assert.equal(second.items.length, 1);
    assert.equal(second.retired.length, 1, 'the old Raj evidence was retired by C4 (superseded)');
    const d = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion: second }, env.ctx);
    assert.ok(d.ok);
    const raj = await q<EntityItem>(env, {
      select: 'entities',
      entity: { kind: 'person', identifier: { scheme: 'email', value: 'raj@acme.test' } },
    });
    assert.equal(raj.length, 1, 'still ONE Raj');
    const titles = await q<ClaimItem>(env, { select: 'claims', entity: { id: raj[0]?.id as string }, predicate: 'title' });
    assert.equal(titles[0]?.current?.value, 'Senior Analyst');
    assert.deepEqual(
      titles[0]?.history.map((h) => h.value),
      ['Senior Analyst'],
      'the superseded version is no longer served',
    );
    assert.equal((await q<EntityItem>(env, { select: 'entities', entityKind: 'person' })).length, 3, 'Anita, Priya, Raj: no duplicates');
    // Replaying the new derivation is again a no-op.
    const digest = env.model.stateDigest();
    const again = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion: second },
      env.ctx,
    );
    assert.ok(again.ok);
    assert.equal(env.model.stateDigest(), digest);
    await env.store.close();
  });
});

test('(9) STRUCTURED QUERIES keep provenance on every answer', async () => {
  await withSandbox(async ({ base }) => {
    const env = await setup(base);
    await loadAll(env);
    for (const select of ['entities', 'relationships', 'claims', 'conflicts'] as const) {
      const items = await q<{
        provenance?: { support: unknown[] };
        current?: { provenance: { support: unknown[] } };
        history?: { provenance: { support: unknown[] } }[];
        claims?: { provenance: { support: unknown[] } }[];
      }>(env, { select });
      assert.ok(items.length > 0, select);
      for (const i of items) {
        const supports =
          i.provenance?.support ??
          i.current?.provenance.support ??
          i.history?.flatMap((h) => h.provenance.support) ??
          i.claims?.flatMap((c) => c.provenance.support) ??
          [];
        assert.ok(supports.length > 0, `${select} item without provenance`);
      }
    }
    const priya = await priyaId(env);
    const mine = await q<RelationshipItem>(env, { select: 'relationships', entity: { id: priya }, relation: 'owns' });
    assert.equal(mine.length, 1);
    // Bounded: a limit truncates and says so.
    const r = await queryKnowledge(env.model, { select: 'documents', limit: 2 }, env.ctx);
    assert.ok(r.ok && r.value.items.length === 2 && r.value.truncated);
    // Unknown entity answers exactly like an empty one (no existence oracle).
    const none = await queryKnowledge(env.model, { select: 'claims', entity: { id: 'ent_doesnotexist' } }, env.ctx);
    assert.ok(none.ok && none.value.items.length === 0 && !none.value.truncated);
    await env.store.close();
  });
});

test('INVALIDATION: tombstone, supersession and source revocation remove knowledge immediately - and still do after a restart', async () => {
  await withSandbox(async ({ base }) => {
    const provider = seedOrg(new OrgProvider());
    const env = await setup(base, { provider });
    await loadAll(env);
    const all = (): Promise<readonly ClaimItem[]> => q<ClaimItem>(env, { select: 'claims', predicate: 'title' });
    assert.ok((await all()).length >= 1);
    // TOMBSTONE: the provider deletes Anita's directory record.
    provider.set(HR, 'c1', { items: [], removed: [{ resourceKey: 'anita', reason: 'deleted' }], next: 'c2' });
    provider.set(HR, 'c2', { items: [], next: 'c2' });
    await env.ingest(HR);
    const titlesNow = await all();
    assert.ok(!titlesNow.some((c) => c.current?.value === 'CFO'), 'a tombstoned record is not returned (not merely flagged)');
    // REVOCATION of a whole source (mail): everything resting only on it disappears.
    const mailEvidence = env.ledger.idsOf(env.sourceOf(MAIL), ['released']);
    assert.ok(mailEvidence.length > 0);
    const revoked = await revokeSourceEvidence({ inventory: env.inventory, ledger: env.ledger }, { sourceId: env.sourceOf(MAIL) }, env.ctx);
    assert.ok(revoked.ok);
    const limits = await q<ClaimItem>(env, { select: 'claims', predicate: 'approval_limit' });
    assert.equal(limits[0]?.current?.value, 500000, 'only the policy document remains');
    assert.equal(
      (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' })).length,
      0,
      'the conflict dissolved with its evidence',
    );
    const assoc = await q<RelationshipItem>(env, { select: 'relationships', relation: 'associated_with' });
    assert.ok(assoc.every((r) => r.provenance.support.every((s) => s.sourceId !== (env.sourceOf(MAIL) as string))));
    await env.store.close();

    // RESTART: the durable ledger still says what it said. A rebuilt model - even fed ALL the old payloads - serves none of it.
    const staging = env.staging;
    const again = await knowledgeEnv(base, { provider, paths: PATHS, skipDiscover: true, staging });
    for (const path of PATHS) {
      const ids = [...again.ledger.idsOf(again.sourceOf(path), ['released', 'revoked', 'purged', 'quarantined'])];
      const r = await deriveKnowledge(
        again.model,
        again.deps,
        { sourceId: again.sourceOf(path), reader: staging, evidenceIds: ids },
        again.ctx,
      ).catch(() => undefined);
      assert.ok(r !== undefined);
      if (path === MAIL)
        assert.ok(!r.ok || r.value.evidenceUsed === 0, 'revoked source: nothing derived (the source is no longer authorized)');
    }
    const limits2 = await q<ClaimItem>(again, { select: 'claims', predicate: 'approval_limit' });
    assert.equal(limits2[0]?.current?.value, 500000);
    assert.equal((await q<ConflictItem>(again, { select: 'conflicts' })).length, 0);
    const titles2 = await q<ClaimItem>(again, { select: 'claims', predicate: 'title' });
    assert.ok(!titles2.some((c) => c.current?.value === 'CFO'), 'the tombstone survived the restart');
    assert.ok(!titles2.some((c) => c.history.some((h) => h.value === 'CFO')));
    // And the model is cold-but-honest before rehydration: an empty model answers empty, never stale data.
    const cold = new KnowledgeModel();
    const coldAnswer = await queryKnowledge(cold, { select: 'claims' }, again.ctx);
    assert.ok(coldAnswer.ok && coldAnswer.value.items.length === 0);
    await again.store.close();
    void ANITA;
    void POLICY;
    void PM;
    void PRIYA;
  });
});

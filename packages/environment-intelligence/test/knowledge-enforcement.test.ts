/**
 * C5 - enforcement tests (offline contract tests; see knowledge-e2e.test.ts for the real-component wiring and what is NOT verified).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeModel,
  StructuredRecordDeriver,
  deriveKnowledge,
  queryKnowledge,
  reviewKnowledge,
  verifyProvenance,
  type Candidate,
  type ClaimItem,
  type ConflictItem,
  type Deriver,
  type EntityItem,
  type Evidence,
  type RelationshipItem,
} from '../src/index.js';
import { withSandbox } from './helpers.js';
import { OrgProvider, authenticated, knowledgeEnv, type KnowledgeEnv } from './support/knowledge-env.js';
import { HR, MAIL, PATHS, PM, POLICY, load, loadAll, org, person, project, seedOrg, team } from './support/org-fixtures.js';

const fresh = async (
  base: string,
  provider = seedOrg(new OrgProvider()),
  policy?: Parameters<typeof knowledgeEnv>[1]['policy'],
): Promise<KnowledgeEnv> => knowledgeEnv(base, { provider, paths: PATHS, ...(policy !== undefined ? { policy } : {}) });
const q = async <T>(env: KnowledgeEnv, query: Parameters<typeof queryKnowledge>[1], ctx = env.ctx): Promise<readonly T[]> => {
  const r = await queryKnowledge(env.model, query, ctx);
  assert.ok(r.ok, r.ok ? '' : r.error.code);
  return r.ok ? (r.value.items as readonly T[]) : [];
};
const events = (env: KnowledgeEnv, op: string) => env.recorder.inner.events().filter((e) => e.operation === op);

// ── eligibility ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('DERIVATION USES ONLY ELIGIBLE EVIDENCE: quarantined, revoked and never-indexed evidence yields nothing', async () => {
  await withSandbox(async ({ base }) => {
    const provider = seedOrg(new OrgProvider());
    const env = await fresh(base, provider);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const ids = ingestion.items.map((i) => i.evidenceId);
    // quarantine one id directly in the ledger
    const quarantined = env.staging.read([ids[0] as never]);
    env.ledger.quarantine('op_q', quarantined);
    const r = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    assert.ok(r.ok);
    assert.equal(r.value.skipped['ineligible'], 1);
    assert.equal(r.value.evidenceUsed, ids.length - 1);
    // staged-but-never-ingested evidence (a discarded batch) is not indexed: skipped
    const stray: Evidence = { ...(env.staging.read([ids[1] as never])[0] as Evidence), id: 'ev_stray' as never, resourceKey: 'stray' };
    env.staging.stage([stray]);
    env.ledger.release('op_stray', [stray]);
    const r2 = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, evidenceIds: ['ev_stray' as never] },
      env.ctx,
    );
    assert.ok(r2.ok);
    assert.equal(r2.value.skipped['not_indexed'], 1);
    assert.equal(r2.value.evidenceUsed, 0);
    await env.store.close();
  });
});

test('DERIVATION BINDING: a reader that returns altered or foreign evidence is refused (content hash, source, resource key)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const real = env.staging.read(ingestion.items.map((i) => i.evidenceId));
    const forgedPayload = real.map((e, i) =>
      i === 0
        ? { ...e, payload: { ...e.payload, record: { type: 'directory_entry', person: person({ employee_id: 'E666' }), title: 'Root' } } }
        : e,
    );
    const liar = { read: () => forgedPayload };
    const r = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: liar, ingestion }, env.ctx);
    assert.ok(r.ok);
    // payload.digest unchanged but the record differs: contentHash (from the digest) still matches, so this ONE is a documented trust edge:
    // payload authenticity is the READER's responsibility (the shipped staging reader is connector-captured). A changed DIGEST is caught:
    const tampered = real.map((e, i) => (i === 0 ? { ...e, payload: { ...e.payload, digest: `sha256:${'0'.repeat(64)}` } } : e));
    const r2 = await deriveKnowledge(
      new KnowledgeModel(),
      env.deps,
      { sourceId: env.sourceOf(HR), reader: { read: () => tampered }, ingestion },
      env.ctx,
    );
    assert.ok(r2.ok);
    assert.equal(r2.value.skipped['mismatch'], 1);
    // a different resource key than the journal indexed
    const moved = real.map((e) => ({ ...e, resourceKey: `${e.resourceKey}-moved` }));
    const r3 = await deriveKnowledge(
      new KnowledgeModel(),
      env.deps,
      { sourceId: env.sourceOf(HR), reader: { read: () => moved }, ingestion },
      env.ctx,
    );
    assert.ok(r3.ok);
    assert.equal(r3.value.evidenceUsed, 0);
    assert.equal(r3.value.skipped['not_indexed'], real.length);
    // an ingestion result from ANOTHER source is refused outright
    const other = await env.ingest(MAIL, { maxBatches: 1 });
    const r4 = await deriveKnowledge(
      new KnowledgeModel(),
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion: other },
      env.ctx,
    );
    assert.ok(!r4.ok && r4.error.code === 'EI_MALFORMED_INPUT');
    await env.store.close();
  });
});

test('PROVENANCE TAMPERING: an altered content hash or a forged batch is reported as mismatch, never verified', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await load(env, HR);
    const s = env.model.assertions()[0]?.support;
    assert.ok(s);
    assert.equal(verifyProvenance(env.model, env.ctx, [s])[0]?.status, 'verified_against_journal');
    assert.equal(verifyProvenance(env.model, env.ctx, [{ ...s, contentHash: `sha256:${'1'.repeat(64)}` }])[0]?.status, 'mismatch');
    const { batchOperationId: _b, ...rehydrated } = s;
    assert.equal(verifyProvenance(env.model, env.ctx, [rehydrated])[0]?.status, 'index_only');
    await env.store.close();
  });
});

// ── fact vs inference ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('INFERENCE RULE: corroborated by two independent sources it is promoted; lose one source and it is a flagged hypothesis again', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    const atlasAssoc = async (): Promise<readonly RelationshipItem[]> =>
      (await q<RelationshipItem>(env, { select: 'relationships', relation: 'associated_with' })).filter(
        (r) => r.confidence.corroboration >= 1,
      );
    const promoted = (await atlasAssoc()).filter((r) => r.confidence.promotedToFact);
    assert.ok(promoted.length >= 1);
    const { revokeSourceEvidence } = await import('../src/index.js');
    assert.ok((await revokeSourceEvidence({ inventory: env.inventory, ledger: env.ledger }, { sourceId: env.sourceOf(PM) }, env.ctx)).ok);
    const after = await atlasAssoc();
    assert.ok(after.length >= 1);
    assert.ok(
      after.every((r) => !r.confidence.promotedToFact && r.confidence.status === 'candidate_hypothesis'),
      'back to flagged',
    );
    await env.store.close();
  });
});

test('SAME SOURCE REPEATED IS NOT INDEPENDENT: two inferences from one source never promote', async () => {
  await withSandbox(async ({ base }) => {
    const p = new OrgProvider();
    const msg = (to: string) => ({
      type: 'message',
      from: person({ email: 'a@x.test' }),
      to: [person({ email: to })],
      project: project('PRJ-X'),
    });
    p.set(MAIL, undefined, {
      items: [
        { key: 'm1', record: msg('b@x.test') },
        { key: 'm2', record: msg('c@x.test') },
      ],
      next: 'c1',
    });
    p.set(MAIL, 'c1', { items: [], next: 'c1' });
    const env = await knowledgeEnv(base, { provider: p, paths: [MAIL] });
    await load(env, MAIL);
    const rels = await q<RelationshipItem>(env, { select: 'relationships', relation: 'associated_with' });
    const a = rels.filter((r) => r.confidence.corroboration === 1);
    assert.ok(a.length >= 3 && a.every((r) => !r.confidence.promotedToFact));
    await env.store.close();
  });
});

// ── entity resolution ─────────────────────────────────────────────────────────────────────────────────────────────────────

const twoPriyas = (): OrgProvider => {
  const p = new OrgProvider();
  p.set(HR, undefined, {
    items: [
      {
        key: 'p1',
        record: {
          type: 'directory_entry',
          person: person({ employee_id: 'E1', email: 'priya.a@acme.test', name: 'Priya Sharma' }),
          title: 'Engineer',
        },
      },
      {
        key: 'p2',
        record: {
          type: 'directory_entry',
          person: person({ employee_id: 'E2', email: 'priya.b@acme.test', name: 'Priya Sharma' }),
          title: 'Lawyer',
        },
      },
    ],
    next: 'c1',
  });
  p.set(HR, 'c1', { items: [], next: 'c1' });
  p.set(MAIL, undefined, {
    items: [{ key: 'm', record: { type: 'message', from: person({ name: 'Priya Sharma' }), to: [person({ email: 'raj@acme.test' })] } }],
    next: 'c1',
  });
  p.set(MAIL, 'c1', { items: [], next: 'c1' });
  return p;
};

test('WEAK EVIDENCE NEVER MERGES: a shared display name keeps entities apart and is reported as a merge CANDIDATE only', async () => {
  await withSandbox(async ({ base }) => {
    const env = await knowledgeEnv(base, { provider: twoPriyas(), paths: [HR, MAIL] });
    await load(env, HR);
    await load(env, MAIL);
    const people = await q<EntityItem>(env, { select: 'entities', entityKind: 'person' });
    const priyas = people.filter((e) => e.identifiers.some((k) => k.endsWith('name:priya sharma')));
    assert.equal(priyas.length, 3, 'two directory people + one name-only mention');
    const nameOnly = priyas.find((e) => !e.identifiers.some((k) => k.includes('email:priya')));
    assert.ok(nameOnly && nameOnly.confidence.status === 'candidate_hypothesis');
    assert.ok(priyas.every((e) => e.mergeCandidates.length >= 1));
    assert.ok(priyas.every((e) => e.merges.length === 0 || e.merges.every((m) => m.kind !== 'human_approved')));
    await env.store.close();
  });
});

test('MERGE / UNMERGE: a human may approve a weak merge (basis recorded, audited); it is reversible and a block splits it', async () => {
  await withSandbox(async ({ base }) => {
    const env = await knowledgeEnv(base, { provider: twoPriyas(), paths: [HR, MAIL] });
    await load(env, HR);
    await load(env, MAIL);
    const approve = await reviewKnowledge(
      env.model,
      {
        action: 'approve_merge',
        kind: 'person',
        a: { scheme: 'name', value: 'Priya Sharma' },
        b: { scheme: 'email', value: 'priya.a@acme.test' },
      },
      env.ctx,
    );
    assert.ok(approve.ok);
    const merged = (
      await q<EntityItem>(env, {
        select: 'entities',
        entity: { kind: 'person', identifier: { scheme: 'email', value: 'priya.a@acme.test' } },
      })
    )[0];
    assert.ok(merged?.merges.some((m) => m.kind === 'human_approved'));
    // Undo.
    assert.ok((await reviewKnowledge(env.model, { action: 'revoke_decision', decisionId: approve.value.decisionId }, env.ctx)).ok);
    const split = (
      await q<EntityItem>(env, {
        select: 'entities',
        entity: { kind: 'person', identifier: { scheme: 'email', value: 'priya.a@acme.test' } },
      })
    )[0];
    assert.ok(split && split.merges.every((m) => m.kind !== 'human_approved'));
    // A block keeps even an approved pair apart.
    assert.ok(
      (
        await reviewKnowledge(
          env.model,
          {
            action: 'approve_merge',
            kind: 'person',
            a: { scheme: 'name', value: 'Priya Sharma' },
            b: { scheme: 'email', value: 'priya.a@acme.test' },
          },
          env.ctx,
        )
      ).ok,
    );
    assert.ok(
      (
        await reviewKnowledge(
          env.model,
          {
            action: 'block_merge',
            kind: 'person',
            a: { scheme: 'name', value: 'Priya Sharma' },
            b: { scheme: 'email', value: 'priya.a@acme.test' },
          },
          env.ctx,
        )
      ).ok,
    );
    const blocked = (
      await q<EntityItem>(env, {
        select: 'entities',
        entity: { kind: 'person', identifier: { scheme: 'email', value: 'priya.a@acme.test' } },
      })
    )[0];
    assert.ok(blocked && blocked.merges.every((m) => m.kind !== 'human_approved'));
    assert.equal(events(env, 'review_knowledge').filter((e) => e.outcome === 'completed').length, 4);
    await env.store.close();
  });
});

test('IDENTITY CONFLICT: one email under two different employee ids is NOT merged; it is reported as a conflict for human review', async () => {
  await withSandbox(async ({ base }) => {
    const p = new OrgProvider();
    p.set(HR, undefined, {
      items: [
        { key: 'a', record: { type: 'directory_entry', person: person({ employee_id: 'E1', email: 'shared@acme.test' }) } },
        { key: 'b', record: { type: 'directory_entry', person: person({ employee_id: 'E2', email: 'shared@acme.test' }) } },
      ],
      next: 'c1',
    });
    p.set(HR, 'c1', { items: [], next: 'c1' });
    const env = await knowledgeEnv(base, { provider: p, paths: [HR] });
    await load(env, HR);
    const ents = await q<EntityItem>(env, { select: 'entities', entityKind: 'person' });
    assert.ok(
      ents.every((e) => e.identifiers.filter((k) => k.includes('employee_id')).length === 1),
      'no entity holds two employee ids',
    );
    const c = await q<ConflictItem>(env, { select: 'conflicts' });
    assert.ok(c.some((x) => x.predicate === 'identity:employee_id' && x.state === 'open'));
    const refused = await reviewKnowledge(env.model, { action: 'resolve_conflict', conflictId: c[0]?.id ?? '', winner: 'E1' }, env.ctx);
    assert.ok(!refused.ok, 'an identity conflict is not resolved by picking a value');
    await env.store.close();
  });
});

// ── conflicts and policy ──────────────────────────────────────────────────────────────────────────────────────────────────

test('EXPLICIT RESOLUTION POLICY resolves with the rule recorded and BOTH claims preserved; a tie still goes to human review', async () => {
  await withSandbox(async ({ base }) => {
    const policy = { id: 'finance-authority', version: '2', rules: [{ kind: 'prefer_source' as const, order: [] as string[] }] };
    const probe = await fresh(base);
    policy.rules[0] = { kind: 'prefer_source', order: [probe.sourceOf(POLICY) as string] };
    await probe.store.close();
  });
  await withSandbox(async ({ base }) => {
    const probe = await fresh(base);
    const policyId = probe.sourceOf(POLICY) as string;
    await probe.store.close();
    await withSandbox(async ({ base: b2 }) => {
      const env = await fresh(b2, seedOrg(new OrgProvider()), {
        id: 'finance-authority',
        version: '2',
        rules: [{ kind: 'prefer_source', order: [policyId] }],
      });
      await loadAll(env);
      const c = (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' }))[0];
      assert.equal(c?.state, 'resolved');
      assert.deepEqual(c?.resolution, { by: 'policy', policy: 'finance-authority@2', rule: 'prefer_source', winner: 500000 });
      assert.equal(c?.claims.length, 2);
      await env.store.close();
    });
    await withSandbox(async ({ base: b3 }) => {
      const env = await fresh(b3, seedOrg(new OrgProvider()), {
        id: 'ties',
        version: '1',
        rules: [{ kind: 'prefer_origin' }, { kind: 'prefer_corroborated' }],
      });
      await loadAll(env);
      const c = (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' }))[0];
      assert.equal(c?.state, 'open', 'both stated, one source each: rules tie, so human review, never a pick');
      await env.store.close();
    });
  });
});

test('HUMAN DECISIONS ARE MEMORY-ONLY (documented): a restart reopens the conflict, it never silently resolves it', async () => {
  await withSandbox(async ({ base }) => {
    const provider = seedOrg(new OrgProvider());
    const env = await fresh(base, provider);
    await loadAll(env);
    const c = (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' }))[0] as ConflictItem;
    assert.ok((await reviewKnowledge(env.model, { action: 'resolve_conflict', conflictId: c.id, winner: 300000 }, env.ctx)).ok);
    // A decision about a value that is not part of the conflict is refused.
    assert.ok(!(await reviewKnowledge(env.model, { action: 'resolve_conflict', conflictId: c.id, winner: 1 }, env.ctx)).ok);
    const staging = env.staging;
    await env.store.close();
    const again = await knowledgeEnv(base, { provider, paths: PATHS, skipDiscover: true, staging });
    for (const path of PATHS) {
      const ids = again.ledger.idsOf(again.sourceOf(path), ['released']);
      assert.ok(
        (await deriveKnowledge(again.model, again.deps, { sourceId: again.sourceOf(path), reader: staging, evidenceIds: ids }, again.ctx))
          .ok,
      );
    }
    const reopened = (await q<ConflictItem>(again, { select: 'conflicts', predicate: 'approval_limit' }))[0];
    assert.equal(reopened?.state, 'open');
    await again.store.close();
  });
});

// ── authority separation, identity, per-call scope ────────────────────────────────────────────────────────────────────────

test('AUTHORITY SEPARATION: ingest, derive, query and review are separate decisions; none implies another', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const derive = () => deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    // ingest + read granted, derive NOT granted -> derive denied (and audited), nothing derived.
    env.policy.derive = false;
    const denied = await derive();
    assert.ok(!denied.ok && denied.error.code === 'EI_AUTHORIZATION_REQUIRED');
    assert.equal(env.model.size, 0);
    assert.ok(events(env, 'derive_knowledge').some((e) => e.outcome === 'denied'));
    // derive granted, ingest revoked: derive still works on already ingested evidence; ingest itself is separately refused.
    env.policy.derive = true;
    env.policy.ingest = false;
    assert.ok((await derive()).ok);
    // query denied without query authority although derive/ingest/review are held.
    env.policy.query = false;
    const noQuery = await queryKnowledge(env.model, { select: 'claims' }, env.ctx);
    assert.ok(!noQuery.ok);
    // review needs its own authority and sees only what the reviewer may query.
    env.policy.query = true;
    env.policy.review = false;
    const noReview = await reviewKnowledge(env.model, { action: 'revoke_decision', decisionId: 'x' }, env.ctx);
    assert.ok(!noReview.ok && noReview.error.code === 'EI_AUTHORIZATION_REQUIRED');
    // Requests carry distinct operations and scopes.
    const ops = new Set(
      env.authz.requests
        .filter((r) => r.operation.endsWith('_knowledge'))
        .map((r) => `${r.operation}:${r.scope.kind === 'resource' ? r.scope.resource.split('/').slice(0, 3).join('/') : ''}`),
    );
    assert.ok(
      [...ops].some((o) => o.startsWith('derive_knowledge')) &&
        [...ops].some((o) => o.startsWith('query_knowledge')) &&
        [...ops].some((o) => o.startsWith('review_knowledge')),
    );
    await env.store.close();
  });
});

test('PRINCIPAL FORGERY: a plain, copied or missing principal is refused before anything is looked up', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    const plain = { kind: 'human' as const, id: 'test-operator-1' };
    const bad = [
      { ...env.ctx, principal: plain },
      { ...env.ctx, principal: JSON.parse(JSON.stringify(env.principal)) },
      { ...env.ctx, principal: undefined },
    ];
    for (const ctx of bad) {
      const c = ctx as typeof env.ctx;
      const a = await queryKnowledge(env.model, { select: 'claims' }, c);
      assert.ok(!a.ok && a.error.code === 'EI_UNAUTHENTICATED');
      const d = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, evidenceIds: [] }, c);
      assert.ok(!d.ok && d.error.code === 'EI_UNAUTHENTICATED');
      const r = await reviewKnowledge(env.model, { action: 'revoke_decision', decisionId: 'x' }, c);
      assert.ok(!r.ok && r.error.code === 'EI_UNAUTHENTICATED');
    }
    // A caller cannot name another principal: queries take none, and results never echo one.
    const me = authenticated('someone-else');
    assert.ok((await queryKnowledge(env.model, { select: 'claims' }, env.as(me))).ok);
    assert.ok(env.authz.requests.filter((r) => r.operation === 'query_knowledge').some((r) => r.principal?.id === 'someone-else'));
    await env.store.close();
  });
});

// ── fail closed ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('AUDIT UNAVAILABLE FAILS CLOSED: attempt refused -> nothing read or derived; completion refused -> no data returned and no state change', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    env.recorder.refuse = (e) => e.operation === 'derive_knowledge' && e.phase === 'attempt';
    const a = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    assert.ok(!a.ok && a.error.code === 'EI_AUDIT_UNAVAILABLE');
    assert.equal(env.model.size, 0);
    env.recorder.refuse = (e) => e.operation === 'derive_knowledge' && e.phase === 'terminal';
    const b = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    assert.ok(!b.ok && b.error.code === 'EI_AUDIT_UNAVAILABLE');
    assert.equal(env.model.size, 0, 'a derivation whose completion was not audited changes nothing');
    env.recorder.refuse = undefined;
    assert.ok((await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx)).ok);
    env.recorder.refuse = (e) => e.operation === 'query_knowledge' && e.phase === 'terminal';
    const c = await queryKnowledge(env.model, { select: 'claims' }, env.ctx);
    assert.ok(!c.ok && c.error.code === 'EI_AUDIT_UNAVAILABLE', 'no data is returned when the query could not be audited');
    env.recorder.refuse = (e) => e.operation === 'query_knowledge' && e.phase === 'attempt';
    assert.ok(!(await queryKnowledge(env.model, { select: 'claims' }, env.ctx)).ok);
    env.recorder.refuse = (e) => e.operation === 'review_knowledge' && e.phase === 'terminal';
    assert.ok(
      !(
        await reviewKnowledge(
          env.model,
          {
            action: 'approve_merge',
            kind: 'person',
            a: { scheme: 'employee_id', value: 'E100' },
            b: { scheme: 'email', value: 'priya@acme.test' },
          },
          env.ctx,
        )
      ).ok,
    );
    assert.equal(env.model.decisions().length, 0);
    await env.store.close();
  });
});

test('STATE UNAVAILABLE FAILS CLOSED: a closed durable store refuses derive, query and review; no store configured is refused too', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    const { state: _s, ...noState } = env.ctx;
    for (const ctx of [noState as typeof env.ctx]) {
      const r = await queryKnowledge(env.model, { select: 'claims' }, ctx);
      assert.ok(!r.ok && r.error.code === 'EI_STATE_UNAVAILABLE');
    }
    await env.store.close();
    const q1 = await queryKnowledge(env.model, { select: 'claims' }, env.ctx);
    assert.ok(!q1.ok && q1.error.code === 'EI_STATE_UNAVAILABLE');
    const d1 = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, evidenceIds: [] }, env.ctx);
    assert.ok(!d1.ok && d1.error.code === 'EI_STATE_UNAVAILABLE');
    const r1 = await reviewKnowledge(env.model, { action: 'revoke_decision', decisionId: 'x' }, env.ctx);
    assert.ok(!r1.ok && r1.error.code === 'EI_STATE_UNAVAILABLE');
  });
});

test('AUTHORIZATION OUTAGE FAILS CLOSED: if the port breaks while checking source access, the query fails; it does not return a partial or open answer', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    env.policy.outage = true;
    const r = await queryKnowledge(env.model, { select: 'claims' }, env.ctx);
    assert.ok(!r.ok && r.error.code === 'EI_INTERNAL');
    await env.store.close();
  });
});

// ── bounds and malformed input ────────────────────────────────────────────────────────────────────────────────────────────

test('LIMITS: oversized input, too many access checks, zero time budget and bad limits are refused, never truncated silently', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const tooMany = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion, limits: { maxEvidence: 1 } },
      env.ctx,
    );
    assert.ok(!tooMany.ok && tooMany.error.code === 'EI_LIMIT_EXCEEDED');
    const timeout = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion, limits: { timeBudgetMs: 0 } },
      env.ctx,
    );
    assert.ok(!timeout.ok && timeout.error.code === 'EI_LIMIT_EXCEEDED');
    assert.equal(env.model.size, 0);
    const insane = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion, limits: { maxEvidence: 10 ** 9 } },
      env.ctx,
    );
    assert.ok(!insane.ok && insane.error.code === 'EI_MALFORMED_INPUT');
    const both = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion, evidenceIds: [] },
      env.ctx,
    );
    assert.ok(!both.ok && both.error.code === 'EI_MALFORMED_INPUT');
    assert.ok((await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx)).ok);
    await load(env, MAIL);
    const checks = await queryKnowledge(env.model, { select: 'claims', limits: { maxAccessChecks: 1 } }, env.ctx);
    assert.ok(!checks.ok && checks.error.code === 'EI_LIMIT_EXCEEDED');
    const qt = await queryKnowledge(env.model, { select: 'claims', limits: { timeBudgetMs: 0 } }, env.ctx);
    assert.ok(!qt.ok && qt.error.code === 'EI_LIMIT_EXCEEDED');
    for (const bad of [
      { select: 'claims' as const, limit: 0 },
      { select: 'claims' as const, asOf: 'not a date' },
      { select: 'nope' as never },
    ]) {
      const r = await queryKnowledge(env.model, bad, env.ctx);
      assert.ok(!r.ok && r.error.code === 'EI_MALFORMED_INPUT');
    }
    const capped = await queryKnowledge(env.model, { select: 'documents', limit: 1_000_000, limits: { maxResults: 3 } }, env.ctx);
    assert.ok(capped.ok && capped.value.items.length === 3 && capped.value.truncated);
    await env.store.close();
  });
});

test('MALFORMED EVIDENCE IS REFUSED AND FLAGGED, not guessed at: bad shapes, unsupported schemas and contradictory dates', async () => {
  await withSandbox(async ({ base }) => {
    const p = new OrgProvider();
    p.set(HR, undefined, {
      items: [
        { key: 'ok', record: { type: 'directory_entry', person: person({ employee_id: 'E1' }), title: 'Fine' } },
        { key: 'no-ids', record: { type: 'directory_entry', person: { kind: 'person', ids: {} } } },
        { key: 'bad-kind', record: { type: 'directory_entry', person: { kind: 'wizard', ids: { x: '1' } } } },
        {
          key: 'dates',
          record: { type: 'directory_entry', person: person({ employee_id: 'E2' }), valid_from: '2026-06-01', valid_to: '2024-01-01' },
        },
        { key: 'unknown-type', record: { type: 'telepathy' } },
        { key: 'not-object', record: 'a string' },
        {
          key: 'huge',
          record: {
            type: 'message',
            from: person({ email: 'a@x.test' }),
            to: Array.from({ length: 70 }, (_, i) => person({ email: `u${i}@x.test` })),
          },
        },
      ],
      next: 'c1',
    });
    p.set(HR, 'c1', { items: [], next: 'c1' });
    const env = await knowledgeEnv(base, { provider: p, paths: [HR] });
    const { derived } = await load(env, HR);
    assert.equal(derived.evidenceUsed, 1);
    assert.equal(
      Object.values(derived.refused).reduce((a, b) => a + b, 0),
      6,
    );
    assert.ok((derived.refused['malformed'] ?? 0) >= 4 && (derived.refused['limit_exceeded'] ?? 0) === 1);
    // An evidence item without the schema marker is unsupported (flagged), not interpreted.
    const raw = new StructuredRecordDeriver().derive({
      ...(env.staging.read(env.ledger.idsOf(env.sourceOf(HR), ['released']))[0] as Evidence),
      payload: { digest: 'x' },
    });
    assert.ok(!raw.ok && raw.error === 'unsupported_schema');
    await env.store.close();
  });
});

test('DERIVER OUTPUT IS UNTRUSTED: a (future, model-backed) deriver that emits malformed structure is refused by the service', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const evil: Deriver = {
      id: 'x.evil',
      version: '1',
      derive: (): ReturnType<Deriver['derive']> => ({
        ok: true,
        value: [
          {
            type: 'claim',
            kind: 'fact',
            subject: { kind: 'person', identifiers: [] },
            predicate: 'x',
            value: 1,
            origin: 'observed',
          } as Candidate,
        ],
      }),
    };
    const r = await deriveKnowledge(
      env.model,
      env.deps,
      { sourceId: env.sourceOf(HR), reader: env.staging, ingestion, deriver: evil },
      env.ctx,
    );
    assert.ok(r.ok);
    assert.equal(r.value.evidenceUsed, 0);
    assert.equal(r.value.refused['malformed'], ingestion.items.length);
    assert.equal(env.model.size, 0);
    await env.store.close();
  });
});

// ── review visibility, secrets ───────────────────────────────────────────────────────────────────────────────────────────

test('REVIEW REQUIRES VISIBILITY: a reviewer cannot decide about, or probe, a conflict built on evidence they cannot read', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    const c = (await q<ConflictItem>(env, { select: 'conflicts', predicate: 'approval_limit' }))[0] as ConflictItem;
    const reviewer = authenticated('reviewer-2');
    const policySource = env.sourceOf(POLICY) as string;
    env.policy.hide = (who, source) => who === 'reviewer-2' && source === policySource;
    const r = await reviewKnowledge(env.model, { action: 'resolve_conflict', conflictId: c.id, winner: 500000 }, env.as(reviewer));
    assert.ok(!r.ok && r.error.code === 'EI_SCOPE_VIOLATION');
    assert.equal(env.model.decisions().length, 0);
    const m = await reviewKnowledge(
      env.model,
      {
        action: 'approve_merge',
        kind: 'person',
        a: { scheme: 'email', value: 'nobody@x.test' },
        b: { scheme: 'email', value: 'priya@acme.test' },
      },
      env.ctx,
    );
    assert.ok(!m.ok, 'an identifier nobody mentioned cannot be merged');
    await env.store.close();
  });
});

test('SECRET NON-LEAKAGE: audit events and error contexts carry ids, digests and counts only - never content, locators or resource keys', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    await q<ClaimItem>(env, { select: 'claims' });
    env.policy.query = false;
    const denied = await queryKnowledge(
      env.model,
      { select: 'claims', entity: { kind: 'person', identifier: { scheme: 'email', value: 'priya@acme.test' } } },
      env.ctx,
    );
    assert.ok(!denied.ok);
    const everything = JSON.stringify([env.recorder.inner.events(), denied.ok ? null : denied.error]);
    for (const needle of [
      'priya@acme.test',
      'Finance Manager',
      'Senior',
      '500000',
      '300000',
      'PRJ-ATLAS',
      'E100',
      'finance-policy',
      'priya-2026',
      'hr-directory',
      'Priya Sharma',
    ])
      assert.ok(!everything.includes(needle), `leaked: ${needle}`);
    for (const e of events(env, 'query_knowledge'))
      assert.ok(e.counts === undefined || Object.values(e.counts).every((n) => typeof n === 'number'));
    // The model's own state digest and ids never embed values either.
    assert.ok(!env.model.stateDigest().includes('priya'));
    // Staged payloads are in memory only: the durable state directory holds no content.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const stateDir = join(base, 'state');
    for (const f of await readdir(stateDir)) {
      const text = await readFile(join(stateDir, f), 'utf8').catch(() => '');
      for (const needle of ['priya@acme.test', 'Finance Manager', '500000', 'PRJ-ATLAS'])
        assert.ok(!text.includes(needle), `${f} persisted ${needle}`);
    }
    await env.store.close();
    void team;
    void org;
  });
});

test("PURGE TARGET: the lifecycle purge deletes the model's copies; sweep drops revoked evidence but never wipes the model during an outage", async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    await loadAll(env);
    const size = env.model.size;
    // Outage: the ledger gate closes (store closed). A sweep must not delete anything.
    const ids = env.ledger.idsOf(env.sourceOf(MAIL), ['released']);
    await env.store.close();
    assert.equal(env.model.sweep(env.ledger), 0);
    assert.equal(env.model.size, size);
    await env.model.purge(ids);
    assert.ok(env.model.size < size);
  });
});

test('GAPS CLOSED BY MUTATION: source authorization, evidence binding, model bound, decision existence, and refusal before any lookup', async () => {
  await withSandbox(async ({ base }) => {
    const env = await fresh(base);
    const ingestion = await env.ingest(HR, { maxBatches: 1 });
    const ids = ingestion.items.map((i) => i.evidenceId);
    // Evidence returned under ANOTHER source id is not accepted for this source.
    const foreign = env.staging.read(ids).map((e) => ({ ...e, sourceId: env.sourceOf(MAIL) }));
    const bound = await deriveKnowledge(
      new KnowledgeModel(),
      env.deps,
      { sourceId: env.sourceOf(HR), reader: { read: () => foreign }, ingestion },
      env.ctx,
    );
    assert.ok(bound.ok);
    assert.equal(bound.value.evidenceUsed, 0);
    assert.equal(bound.value.skipped['mismatch'], ids.length);
    // The model has a ceiling: a derivation that would exceed it is refused whole.
    const small = new KnowledgeModel({ maxAssertions: 2 });
    const full = await deriveKnowledge(small, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    assert.ok(!full.ok && full.error.code === 'EI_LIMIT_EXCEEDED');
    assert.equal(small.size, 0);
    // An unknown decision cannot be revoked.
    const none = await reviewKnowledge(env.model, { action: 'revoke_decision', decisionId: 'rvw_nope' }, env.ctx);
    assert.ok(!none.ok && none.error.code === 'EI_MALFORMED_INPUT');
    // Source authorization is checked on its own: evidence is still eligible, but the inventory says the source is no longer authorized.
    env.inventory.apply(env.sourceOf(HR), 'authorization_revoked', '2026-10-30T00:00:00.000Z');
    const stale = await deriveKnowledge(env.model, env.deps, { sourceId: env.sourceOf(HR), reader: env.staging, ingestion }, env.ctx);
    assert.ok(!stale.ok && stale.error.code === 'EI_AUTHORIZATION_REQUIRED');
    assert.equal(env.model.size, 0);
    // A caller without identity, or a closed store, is refused BEFORE the authorization port is consulted at all.
    const asked = env.authz.requests.length;
    const plain = { ...env.ctx, principal: { kind: 'human' as const, id: 'x' } };
    assert.ok(!(await queryKnowledge(env.model, { select: 'claims' }, plain)).ok);
    assert.equal(env.authz.requests.length, asked, 'no authorization request for an unauthenticated caller');
    await env.store.close();
    assert.ok(!(await queryKnowledge(env.model, { select: 'claims' }, env.ctx)).ok);
    assert.equal(env.authz.requests.length, asked, 'no authorization request while the durable state is not operational');
  });
});

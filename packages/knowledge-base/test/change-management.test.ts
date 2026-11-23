import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FsKnowledgeStore, KnowledgeBase, type ChangeSet, type KnowledgeError } from '../src/index.js';
import { KNOWN_BAD, SRC, claimRec, entityRec } from './fixtures/known-bad-change-sets.js';

const A = { id: 'u-author', kind: 'user' };
const R = { id: 'u-reviewer', kind: 'user' };
const T = 't1';
const OTHER_SRC = 'b'.repeat(64);

async function make(): Promise<KnowledgeBase> {
  let clock = 0;
  const now = (): string => new Date(Date.UTC(2026, 0, 1) + (clock += 1000)).toISOString();
  return new KnowledgeBase(await FsKnowledgeStore.open(await mkdtemp(join(tmpdir(), 'bkb-cm-')), T), now);
}

async function base(kb: KnowledgeBase): Promise<{ entityId: string; claimId: string }> {
  const e = entityRec(T, 'Acme');
  const c = claimRec(T, 'clm_000000000000000000000101', e.id, 'refunds within 14 days');
  const cs = (await kb.propose({
    operations: [
      { op: 'add', record: e },
      { op: 'add', record: c },
    ],
    origin: { kind: 'manual' },
    proposedBy: A,
  }))!;
  await kb.approve(cs.changeSetId, R, 'base');
  return { entityId: e.id, claimId: c.id };
}

const code = (e: unknown): string => (e as KnowledgeError).code;

describe('UW-11a change management', () => {
  it('UW-11a: previewing a change set builds the next state without moving the head', async () => {
    const kb = await make();
    await base(kb);
    const head = await kb.head();
    const eventsBefore = (await kb.store.events()).length;
    const add = entityRec(T, 'Globex');
    const cs = (await kb.propose({ operations: [{ op: 'add', record: add }], origin: { kind: 'manual' }, proposedBy: A }))!;
    const preview = await kb.previewApproval(cs.changeSetId);
    assert.equal(preview.stale, false);
    assert.deepEqual(preview.diff.added, [add.id]);
    assert.equal((await kb.head()).stateId, head.stateId);
    assert.equal((await kb.store.events()).length, eventsBefore + 1); // only the proposal event
    const approved = await kb.approve(cs.changeSetId, R, 'ok');
    assert.equal(approved.digest, preview.nextState.digest);
    assert.equal(await kb.contentRoot(approved.stateId), preview.contentRoot);
  });

  it('UAC-21: edits in a proposed change set leave the head unchanged until approval', async () => {
    const kb = await make();
    const b = await base(kb);
    const head = await kb.head();
    await kb.propose({
      operations: [{ op: 'retire', recordId: b.claimId, lifecycle: 'expired', reason: 'x' }],
      origin: { kind: 'manual' },
      proposedBy: A,
    });
    assert.equal((await kb.head()).stateId, head.stateId);
    assert.equal((await kb.head()).digest, head.digest);
  });

  it('UAC-21: every known-bad change set is blocked with its expected finding', async () => {
    assert.ok(KNOWN_BAD.length >= 10);
    for (const bad of KNOWN_BAD) {
      const kb = await make();
      const b = await base(kb);
      const cs = (await kb.propose({ operations: bad.build({ tenant: T, ...b }), origin: { kind: bad.origin }, proposedBy: A }))!;
      assert.ok(
        cs.findings.some((f) => f.severity === 'error' && f.code === bad.code),
        `${bad.name}: expected ${bad.code}, got ${cs.findings.map((f) => f.code).join(',')}`,
      );
      await assert.rejects(kb.approve(cs.changeSetId, R, 'no'), (e) => code(e) === 'invalid_change_set', bad.name);
    }
  });

  it('UW-11a: the dependency root changes only when a record citing the given sources changes', async () => {
    const kb = await make();
    const b = await base(kb);
    const s0 = (await kb.head()).stateId;
    const mine = new Set([SRC]);
    const root0 = await kb.dependencyRoot(s0, mine);
    // another source: unchanged
    const other = entityRec(T, 'Other', OTHER_SRC);
    const cs1 = (await kb.propose({ operations: [{ op: 'add', record: other }], origin: { kind: 'manual' }, proposedBy: A }))!;
    const s1 = (await kb.approve(cs1.changeSetId, R, 'ok')).stateId;
    assert.equal(await kb.dependencyRoot(s1, mine), root0);
    assert.notEqual(await kb.dependencyRoot(s1, new Set([OTHER_SRC])), root0);
    // a record citing my source: changes
    const cs2 = (await kb.propose({
      operations: [{ op: 'retire', recordId: b.claimId, lifecycle: 'expired', reason: 'x' }],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!;
    const s2 = (await kb.approve(cs2.changeSetId, R, 'ok')).stateId;
    assert.notEqual(await kb.dependencyRoot(s2, mine), root0);
    // a conflict on one of my records: changes
    const kb2 = await make();
    const b2 = await base(kb2);
    const r2 = await kb2.dependencyRoot((await kb2.head()).stateId, mine);
    const rival = claimRec(T, 'clm_000000000000000000000102', b2.entityId, 'refunds within 30 days', OTHER_SRC);
    const cs3 = (await kb2.propose({ operations: [{ op: 'add', record: rival }], origin: { kind: 'manual' }, proposedBy: A }))!;
    const s3 = await kb2.approve(cs3.changeSetId, R, 'ok');
    assert.equal(s3.conflicts.length, 1);
    assert.notEqual(await kb2.dependencyRoot(s3.stateId, mine), r2);
    // empty set: a fixed root
    const e1 = await kb.dependencyRoot(s0, new Set());
    assert.equal(e1, await kb.dependencyRoot(s0, new Set(['c'.repeat(64)])));
  });

  it('UW-11a: a rollback retires what was added and restores what was replaced; its state has the target content root', async () => {
    const kb = await make();
    const b = await base(kb);
    const target = await kb.head();
    const extra = entityRec(T, 'Globex');
    const cs1 = (await kb.propose({
      operations: [
        { op: 'add', record: extra },
        { op: 'retire', recordId: b.claimId, lifecycle: 'expired', reason: 'x' },
      ],
      origin: { kind: 'manual' },
      proposedBy: A,
    }))!;
    await kb.approve(cs1.changeSetId, R, 'ok');
    const rb = await kb.proposeRollback(target.stateId, A, 'undo');
    assert.equal(rb.origin.kind, 'rollback');
    assert.equal(rb.findings.filter((f) => f.severity === 'error').length, 0);
    const next = await kb.approve(rb.changeSetId, R, 'ok');
    const live = (await kb.records(next.stateId)).map((x) => x.record.id).sort();
    const was = (await kb.records(target.stateId)).map((x) => x.record.id).sort();
    assert.deepEqual(live, was);
    assert.equal(next.parentStateId !== target.stateId, true); // forward-only: a new state
  });

  it('UW-11a: a rollback to a state that is not an ancestor is refused', async () => {
    const kb = await make();
    await base(kb);
    await assert.rejects(kb.proposeRollback('ks_unknown', A, 'x'), (e) => code(e) === 'invalid_change_set');
    await assert.rejects(kb.proposeRollback((await kb.head()).stateId, A, 'x'), (e) => code(e) === 'invalid_change_set');
  });

  it('UW-11a: two approvals racing against one head: exactly one wins and the other preview reports stale', async () => {
    const kb = await make();
    await base(kb);
    const a = (await kb.propose({ operations: [{ op: 'add', record: entityRec(T, 'One') }], origin: { kind: 'manual' }, proposedBy: A }))!;
    const c = (await kb.propose({ operations: [{ op: 'add', record: entityRec(T, 'Two') }], origin: { kind: 'manual' }, proposedBy: A }))!;
    const results = await Promise.allSettled([kb.approve(a.changeSetId, R, 'ok'), kb.approve(c.changeSetId, R, 'ok')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = results.findIndex((r) => r.status === 'rejected') === 0 ? a : c;
    assert.equal(code((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), 'stale_base');
    assert.equal((await kb.previewApproval(lost.changeSetId)).stale, true);
  });

  it('UW-11a: duplicate content and contradictions are warned, not blocked', async () => {
    const kb = await make();
    const b = await base(kb);
    const dup = claimRec(T, 'clm_000000000000000000000103', b.entityId, 'refunds within 14 days');
    const contra = claimRec(T, 'clm_000000000000000000000104', b.entityId, 'refunds within 90 days');
    const cs = (await kb.propose({
      operations: [
        { op: 'add', record: dup },
        { op: 'add', record: contra },
      ],
      origin: { kind: 'manual' },
      proposedBy: A,
    })) as ChangeSet;
    const codes = cs.findings.map((f) => f.code);
    assert.ok(codes.includes('duplicate-content'));
    assert.ok(codes.includes('contradiction'));
    assert.equal(cs.findings.filter((f) => f.severity === 'error').length, 0);
    await kb.approve(cs.changeSetId, R, 'ok');
  });

  it('UW-11a: a caller cannot add an error finding to a change set', async () => {
    const kb = await make();
    await assert.rejects(
      kb.propose({
        operations: [{ op: 'add', record: entityRec(T, 'X') }],
        origin: { kind: 'manual' },
        proposedBy: A,
        extraFindings: [{ severity: 'error', code: 'x', message: 'x' }],
      }),
      (e) => code(e) === 'invalid_change_set',
    );
  });
});

/**
 * C4 - ingestion / incremental sync: core behaviour.
 *
 * KIND OF TEST: OFFLINE CONTRACT tests. A scripted in-memory provider is served through the REAL connector registry, framework
 * enforcement (`runEnforced`), evidence ledger, audit recorder and durable `EiStateStore`. Nothing here touches a network or a
 * credential, and nothing here verifies any real provider (live Microsoft OAuth remains UNVERIFIED).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAIN_LOG_FILE } from '@xo/audit';
import {
  DiscoveryErrorCode,
  ingestSource,
  ingestionBinding,
  ingestionScopeDigest,
  provenanceDigestOf,
  resourceDigestOf,
  type EvidenceId,
  type IngestionResult,
} from '../src/index.js';
import { TEST_PRINCIPAL, withSandbox } from './helpers.js';
import { SCOPE, SCRIPT_CONNECTOR_ID, ingestEnv, type IngestEnv, type ScriptedProvider } from './support/scripted-sync.js';

/** Checkpoint without its provenance digest (asserted separately by the PROVENANCE DIGEST test). */
const noProv = (c: { provenance?: string } | undefined) => {
  if (c === undefined) return undefined;
  const { provenance: _digest, ...rest } = c;
  return rest;
};

const request = (env: IngestEnv, limits?: Parameters<typeof ingestSource>[1]['limits']) => ({
  sourceId: env.sourceId,
  kind: 'document_content' as const,
  scope: SCOPE,
  ...(limits !== undefined ? { limits } : {}),
});

function seedPages(p: ScriptedProvider): void {
  p.set(undefined, {
    items: [
      { key: 'a.txt', content: 'alpha' },
      { key: 'b.txt', content: 'beta' },
    ],
    next: 'cur_1',
  });
  p.set('cur_1', { items: [{ key: 'c.txt', content: 'gamma' }], next: 'cur_2' });
  p.set('cur_2', { items: [], next: 'cur_2' });
}

const run = async (env: IngestEnv, limits?: Parameters<typeof ingestSource>[1]['limits']): Promise<IngestionResult> => {
  const r = await ingestSource(env.deps, request(env, limits), env.ctx);
  assert.ok(r.ok, `ingest should succeed: ${r.ok ? '' : r.error.code}`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
};

const ledgerIds = (env: IngestEnv, state: 'released' | 'quarantined' | 'revoked' | 'purged'): readonly EvidenceId[] =>
  env.ledger
    .exportEntries()
    .filter((e) => e.state === state)
    .map((e) => e.id);

test('FIRST INGEST: pages are committed in order, the checkpoint is durable, and every item carries full provenance', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    seedPages(env.provider);
    const result = await run(env);

    assert.equal(result.status, 'caught_up');
    assert.equal(result.batches, 3);
    assert.equal(result.items.length, 3);
    assert.equal(result.sourceRevoked, false);
    assert.deepEqual(noProv(result.checkpoint), { seq: 3, cursor: 'cur_2', complete: true });
    assert.deepEqual(env.provider.reads, [undefined, 'cur_1', 'cur_2']);
    assert.equal(ledgerIds(env, 'released').length, 3);

    const scopeDigest = ingestionScopeDigest(SCOPE);
    assert.ok(scopeDigest);
    for (const item of result.items) {
      assert.equal(item.sourceId, env.sourceId);
      assert.equal(item.connectorId, SCRIPT_CONNECTOR_ID);
      assert.equal(item.connectorVersion, '0.0.1');
      assert.equal(item.principal.id, TEST_PRINCIPAL.id);
      assert.equal(item.scopeDigest, scopeDigest);
      assert.match(item.contentHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(item.operationId, /^op_/);
      assert.equal(item.ingestedAt, '2026-10-30T00:00:00.000Z');
      assert.match(item.observedAt, /^2026-10-30T/);
      assert.equal(env.ledger.isEligible(item.evidenceId), true);
    }
    assert.equal(result.items[0]?.cursorBefore, undefined, 'the first batch was read from the beginning');
    assert.equal(result.items[0]?.cursorAfter, 'cur_1');
    assert.equal(result.items[2]?.cursorBefore, 'cur_1');
    await env.store.close();

    // Durable: a restart restores the checkpoint, the resource index and the released evidence.
    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    const binding = ingestionBinding({
      sourceId: env.sourceId,
      connectorId: SCRIPT_CONNECTOR_ID,
      principal: TEST_PRINCIPAL,
      kind: 'document_content',
      scopeDigest: scopeDigest as string,
    });
    assert.equal(result.binding, binding);
    assert.deepEqual(noProv(again.store.checkpointOf(binding)), {
      binding,
      sourceId: env.sourceId,
      seq: 3,
      cursor: 'cur_2',
      complete: true,
    });
    assert.equal(again.store.ingestedResources(env.sourceId).size, 3);
    assert.equal(ledgerIds(again, 'released').length, 3);
    await again.store.close();
  });
});

test('PROVENANCE DIGEST: the returned provenance verifies against the durable checkpoint, before and after a restart', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    seedPages(env.provider);
    const r = await ingestSource(env.deps, { ...request(env), limits: { maxBatches: 1 } }, env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.items.length, 2);
    const digest = provenanceDigestOf(r.value.items);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(r.value.checkpoint?.provenance, digest);
    assert.equal(env.store.checkpointOf(r.value.binding)?.provenance, digest);
    // Any alteration of a returned item (a different content hash, cursor or time) no longer matches.
    const first = r.value.items[0];
    assert.ok(first);
    assert.notEqual(provenanceDigestOf([{ ...first, contentHash: `sha256:${'0'.repeat(64)}` }, ...r.value.items.slice(1)]), digest);
    assert.notEqual(provenanceDigestOf(r.value.items.slice(1)), digest);
    await env.store.close();
    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(again.store.checkpointOf(r.value.binding)?.provenance, digest, 'the digest is durable');
    const raw = await readFile(join(again.dir, CHAIN_LOG_FILE), 'utf8');
    assert.equal(raw.includes(first.contentHash), false, 'per-item provenance itself is never persisted');
    await again.store.close();
  });
});

test('INCREMENTAL: a later run resumes from the checkpoint and reads only what is new', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    seedPages(env.provider);
    await run(env);
    env.provider.reads.length = 0;

    env.provider.set('cur_2', { items: [{ key: 'd.txt', content: 'delta' }], next: 'cur_3' });
    env.provider.set('cur_3', { items: [], next: 'cur_3' });
    const second = await run(env);

    assert.deepEqual(env.provider.reads, ['cur_2', 'cur_3'], 'the run started at the last good checkpoint, not at the beginning');
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]?.resourceDigest, resourceDigestOf(env.sourceId, 'document_content', 'd.txt'));
    assert.deepEqual(noProv(second.checkpoint), { seq: 5, cursor: 'cur_3', complete: true });
    assert.equal(ledgerIds(env, 'released').length, 4);
    await env.store.close();
  });
});

test('IDEMPOTENCY: a replayed or duplicate batch changes nothing (no records, no ledger change, same checkpoint)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    seedPages(env.provider);
    await run(env);
    const records = env.store.diagnostics().records;
    const counts = env.ledger.counts();
    const entries = env.ledger.exportEntries();

    // The provider hands back the SAME final batch again (a duplicate), and then the whole history is replayed from the start.
    const third = await run(env);
    assert.equal(third.items.length, 0);
    assert.equal(third.checkpoint?.seq, 3, 'an unchanged batch does not advance the checkpoint sequence');
    assert.equal(env.store.diagnostics().records, records, 'nothing was journaled');
    assert.deepEqual(env.ledger.counts(), counts);

    const c4Records = async (): Promise<number> =>
      ((await readFile(join(env.dir, CHAIN_LOG_FILE), 'utf8')).match(/"rec":"(checkpoint|tombstone)"/g) ?? []).length;
    const before = await c4Records();
    env.provider.set('cur_2', {
      items: [
        { key: 'a.txt', content: 'alpha' },
        { key: 'b.txt', content: 'beta' },
      ],
      next: 'cur_2',
    });
    const replay = await run(env);
    assert.equal(replay.retired.length, 0);
    // The connector's own completion audit re-releases the same ids (C1, state-idempotent); C4 itself journals nothing.
    assert.equal(await c4Records(), before, 'a duplicate batch of already-ingested content adds no checkpoint or tombstone');
    assert.deepEqual(
      env.ledger.exportEntries().map((e) => [e.id, e.state]),
      entries.map((e) => [e.id, e.state]),
      'the ledger is identical',
    );
    await env.store.close();
  });
});

test('CHANGED CONTENT: the superseded version is retired (never silently kept) and only the new version is eligible', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'policy.txt', content: 'v1' }], next: 'cur_1' });
    env.provider.set('cur_1', { items: [], next: 'cur_1' });
    const first = await run(env);
    const v1 = first.items[0]?.evidenceId as EvidenceId;
    assert.equal(env.ledger.isEligible(v1), true);

    env.provider.set('cur_1', { items: [{ key: 'policy.txt', content: 'v2' }], next: 'cur_2' });
    env.provider.set('cur_2', { items: [], next: 'cur_2' });
    const second = await run(env);
    const v2 = second.items[0]?.evidenceId as EvidenceId;

    assert.notEqual(v1, v2);
    assert.deepEqual(
      second.retired.map((r) => [r.evidenceId, r.reason]),
      [[v1, 'superseded']],
    );
    assert.equal(env.ledger.stateOf(v1), 'purged');
    assert.equal(env.ledger.isEligible(v1), false);
    assert.equal(env.ledger.isEligible(v2), true);
    assert.deepEqual([...env.store.ingestedResources(env.sourceId).values()].flat(), [v2], 'the index holds only the current version');
    await env.store.close();
  });
});

test('DELETION and ACCESS LOSS: removed objects are tombstoned (ineligible, durable); reappearance is a NEW audited release', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, {
      items: [
        { key: 'keep.txt', content: 'k' },
        { key: 'gone.txt', content: 'g' },
        { key: 'locked.txt', content: 'l' },
      ],
      next: 'cur_1',
    });
    env.provider.set('cur_1', { items: [], next: 'cur_1' });
    const first = await run(env);
    const idOf = (key: string): EvidenceId =>
      first.items.find((i) => i.resourceDigest === resourceDigestOf(env.sourceId, 'document_content', key))?.evidenceId as EvidenceId;

    env.provider.set('cur_1', {
      items: [],
      removed: [
        { resourceKey: 'gone.txt', reason: 'deleted' },
        { resourceKey: 'locked.txt', reason: 'access_lost' },
      ],
      next: 'cur_2',
    });
    env.provider.set('cur_2', { items: [], next: 'cur_2' });
    const second = await run(env);

    assert.deepEqual(second.retired.map((r) => r.reason).sort(), ['access_lost', 'deleted']);
    assert.equal(env.ledger.isEligible(idOf('gone.txt')), false);
    assert.equal(env.ledger.isEligible(idOf('locked.txt')), false);
    assert.equal(env.ledger.isEligible(idOf('keep.txt')), true);
    assert.equal(env.ledger.stateOf(idOf('gone.txt')), 'purged');
    await env.store.close();

    const restarted = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(restarted.ledger.isEligible(idOf('gone.txt')), false, 'a tombstone survives a restart');
    assert.equal(restarted.ledger.isEligible(idOf('locked.txt')), false);
    assert.equal(restarted.ledger.isEligible(idOf('keep.txt')), true);
    assert.equal(restarted.store.ingestedResources(env.sourceId).size, 1);

    // The object reappears (re-shared): a fresh, authorized, audited release legitimately makes it eligible again.
    restarted.provider.set('cur_2', { items: [{ key: 'gone.txt', content: 'g' }], next: 'cur_3' });
    restarted.provider.set('cur_3', { items: [], next: 'cur_3' });
    const third = await run(restarted);
    assert.equal(third.items.length, 1);
    assert.equal(restarted.ledger.isEligible(idOf('gone.txt')), true);
    await restarted.store.close();
  });
});

test('JOURNAL CONTENT: only digests, ids and counts are persisted - never resource keys, locators, scope paths or content', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'merger-plan-confidential.docx', content: 'TOP-SECRET-BODY' }], next: 'cur_1' });
    env.provider.set('cur_1', { items: [], removed: [{ resourceKey: 'deleted-hr-file.pdf', reason: 'deleted' }], next: 'cur_1' });
    await run(env);
    const raw = await readFile(join(env.dir, CHAIN_LOG_FILE), 'utf8');
    assert.match(raw, /"rec":"checkpoint"/);
    for (const forbidden of [
      'merger-plan-confidential',
      'deleted-hr-file',
      'TOP-SECRET-BODY',
      '/scripted/finance-share',
      'finance-share',
    ]) {
      assert.equal(raw.includes(forbidden), false, `the journal must not contain "${forbidden}"`);
    }
    await env.store.close();
  });
});

test('DISCOVERY IS UNCHANGED: ingestSource without a durable store is refused (no memory-only checkpoints)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    seedPages(env.provider);
    const { state: _state, ...withoutState } = env.ctx;
    const r = await ingestSource(env.deps, request(env), withoutState);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(env.provider.reads.length, 0, 'the connector was never called');
    await env.store.close();
  });
});

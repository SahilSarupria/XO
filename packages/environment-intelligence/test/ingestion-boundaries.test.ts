/**
 * C4 - ingestion authority boundaries, identity, checkpoint binding, revocation and fail-closed behaviour.
 *
 * KIND OF TEST: OFFLINE CONTRACT tests over a scripted provider and the real EI components (see ingestion.test.ts). No live provider.
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
  type AuthorizationDecision,
  type AuthorizationPort,
  type AuthorizationRequest,
  type ConnectorContext,
  type EvidenceId,
} from '../src/index.js';
import { mintDevelopmentDecision } from '../src/trusted-decision.js';
import { TEST_PRINCIPAL, authenticated, withSandbox } from './helpers.js';
import { SCOPE, SCOPE_OF, SCRIPT_CONNECTOR_ID, ingestEnv, type IngestEnv } from './support/scripted-sync.js';

/** Checkpoint without its provenance digest (asserted separately by the PROVENANCE DIGEST test). */
const noProv = (c: { provenance?: string } | undefined) => {
  if (c === undefined) return undefined;
  const { provenance: _digest, ...rest } = c;
  return rest;
};

const req = (env: IngestEnv, extra: Record<string, unknown> = {}) => ({
  sourceId: env.sourceId,
  kind: 'document_content' as const,
  scope: SCOPE,
  ...extra,
});
const codeOf = async (env: IngestEnv, ctx: ConnectorContext = env.ctx, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await ingestSource(env.deps, req(env, extra), ctx);
  return r.ok ? `ok:${r.value.stoppedBecause?.code ?? r.value.status}` : r.error.code;
};
const simple = (env: IngestEnv): void => {
  env.provider.set(undefined, {
    items: [
      { key: 'a.txt', content: 'a' },
      { key: 'b.txt', content: 'b' },
    ],
    next: 'cur_1',
  });
  env.provider.set('cur_1', { items: [], next: 'cur_1' });
};
const noC4Records = async (env: IngestEnv): Promise<boolean> =>
  !/"rec":"(checkpoint|tombstone)"/.test(await readFile(join(env.dir, CHAIN_LOG_FILE), 'utf8'));

// ── authority boundaries ──────────────────────────────────────────────────────────────────────────────────────────────

test('BOUNDARY: a validated, authorized source with a granted READ still has NO permission to ingest', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base, { policy: { ingest: false } });
    simple(env);
    assert.equal(env.inventory.get(env.sourceId)?.axes.authorization, 'granted');
    assert.equal(await codeOf(env), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env.provider.reads.length, 0, 'no content was read: the ingest decision precedes the connector call');
    assert.equal(await noC4Records(env), true);
    assert.equal(env.ledger.counts().released, 0);
    const asked = env.authz.requests.filter((r) => r.operation === 'ingest_source');
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.permission, 'data.write');
    assert.equal(asked[0]?.scope.kind === 'resource' ? asked[0].scope.resource : '', `environment-intelligence/ingestion/${env.sourceId}`);
    await env.store.close();
  });
});

test('BOUNDARY: a revoked source is refused BEFORE any ingestion audit attempt is opened or content is read', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    env.inventory.apply(env.sourceId, 'authorization_revoked', env.clock.now().toISOString());
    assert.equal(await codeOf(env), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env.provider.reads.length, 0);
    const ingestEvents = env.recorder.inner.events().filter((e) => e.operation === 'ingest_source');
    assert.equal(ingestEvents.length, 0, 'no write-ahead attempt exists for a request that was never eligible');
    assert.equal(await noC4Records(env), true);
    await env.store.close();
  });
});

test('BOUNDARY: ingestion permission does NOT grant a content read (the connector still asks, and is refused)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base, { policy: { read: false } });
    simple(env);
    assert.equal(await codeOf(env), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env.ledger.counts().released, 0);
    assert.equal(env.inventory.get(env.sourceId)?.axes.authorization, 'granted', 'a missing read decision is not a revocation');
    assert.equal(await noC4Records(env), true);
    await env.store.close();
  });
});

test('BOUNDARY: the ingestion decision is requested for EVERY batch and for the authenticated principal of the call', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    const asks = env.authz.requests.filter((x) => x.operation === 'ingest_source');
    assert.equal(asks.length, r.ok ? r.value.batches : -1);
    assert.ok(asks.every((a) => a.principal?.id === TEST_PRINCIPAL.id));
    assert.ok(
      asks.every((a) => a.connectorId !== SCRIPT_CONNECTOR_ID),
      "ingestion is its own authority, not the connector's",
    );
    await env.store.close();
  });
});

test('IDENTITY: a plain object, a spread copy or a missing principal cannot ingest, and nothing is consulted', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const asked = env.authz.requests.length;
    const forged = { kind: 'human', id: 'test-operator-1' };
    for (const principal of [forged, { ...TEST_PRINCIPAL }, undefined]) {
      const { principal: _drop, ...rest } = env.ctx;
      const ctx: ConnectorContext = { ...rest };
      if (principal !== undefined) Reflect.set(ctx, 'principal', principal); // a forged, unauthenticated identity
      assert.equal(await codeOf(env, ctx), DiscoveryErrorCode.UNAUTHENTICATED);
    }
    assert.equal(env.authz.requests.length, asked, 'no authorization decision was requested for a forged identity');
    assert.equal(env.provider.reads.length, 0);
    assert.equal(await noC4Records(env), true);
    await env.store.close();
  });
});

// ── checkpoint binding ────────────────────────────────────────────────────────────────────────────────────────────────

test('BINDING: principal, scope, kind and source each produce a distinct checkpoint chain', () => {
  const sd = ingestionScopeDigest(SCOPE) as string;
  const base = { sourceId: 'src_x', connectorId: 'c', principal: TEST_PRINCIPAL, kind: 'document_content', scopeDigest: sd };
  const b = ingestionBinding(base);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(b, ingestionBinding({ ...base, principal: authenticated('someone-else') }));
  assert.notEqual(b, ingestionBinding({ ...base, principal: authenticated('test-operator-1', 'service') }));
  assert.notEqual(b, ingestionBinding({ ...base, scopeDigest: ingestionScopeDigest(SCOPE_OF('/other')) as string }));
  assert.notEqual(b, ingestionBinding({ ...base, kind: 'resource_inventory' }));
  assert.notEqual(b, ingestionBinding({ ...base, sourceId: 'src_y' }));
  assert.equal(ingestionScopeDigest({ b: 1, a: 2 }), ingestionScopeDigest({ a: 2, b: 1 }), 'scope digest is key-order independent');
});

test("BINDING: a different principal cannot resume or advance another principal's checkpoint", async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const first = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(first.ok);
    env.provider.reads.length = 0;

    const other = authenticated('operator-two');
    const second = await ingestSource(env.deps, req(env), { ...env.ctx, principal: other });
    assert.ok(second.ok);
    assert.equal(env.provider.reads[0], undefined, "the other principal starts from the beginning: it never saw the first one's cursor");
    if (first.ok && second.ok) {
      assert.notEqual(first.value.binding, second.value.binding);
      assert.equal(env.store.checkpointOf(first.value.binding)?.seq, first.value.checkpoint?.seq);
      assert.equal(
        second.value.items.every((i) => i.principal.id === 'operator-two'),
        true,
      );
    }
    // A different scope is likewise a separate chain.
    env.provider.reads.length = 0;
    const third = await ingestSource(env.deps, { ...req(env), scope: SCOPE_OF(SCOPE.path) }, env.ctx);
    assert.ok(third.ok);
    await env.store.close();
  });
});

// ── cursor handling ───────────────────────────────────────────────────────────────────────────────────────────────────

test('CURSOR FORGERY: a provider cursor that cannot be persisted safely is refused, contained and never becomes a checkpoint', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eHgifQ.c2lnbmF0dXJlc2lnbmF0dXJl';
  const bad = ['has space', 'new\nline', 'nul\u0000byte', 'a'.repeat(201), 'pad==', 'path/with/slash', jwt, 'x'.repeat(60)];
  for (const cursor of bad) {
    await withSandbox(async ({ base }) => {
      const env = await ingestEnv(base);
      env.provider.set(undefined, { items: [{ key: 'a.txt', content: 'a' }], next: cursor });
      const r = await ingestSource(env.deps, req(env), env.ctx);
      assert.equal(r.ok, false, `cursor ${JSON.stringify(cursor.slice(0, 20))} must be refused`);
      if (!r.ok)
        assert.ok([DiscoveryErrorCode.MALFORMED_INPUT, DiscoveryErrorCode.STATE_UNAVAILABLE].includes(r.error.code as never), r.error.code);
      assert.equal(env.ledger.counts().released, 0, `contained, not left eligible: ${JSON.stringify(cursor.slice(0, 24))}`);
      assert.equal(await noC4Records(env), true, 'no checkpoint was written');
      assert.equal(env.store.checkpointOf('x'.repeat(64)), undefined);
      await env.store.close();
    });
  }
});

test('CURSOR FORGERY: a cursor outside the persistable alphabet is refused as MALFORMED before any write is attempted', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'a.txt', content: 'a' }], next: 'pad==' });
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
      assert.equal(r.error.context?.['field'], 'nextCursor');
      assert.equal(r.error.context?.['reason'], 'cursor_not_persistable');
    }
    assert.equal(await noC4Records(env), true);
    await env.store.close();
  });
});

test('CURSOR TAMPER: editing a persisted checkpoint on disk is detected and ingestion fails closed after restart', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    assert.ok((await ingestSource(env.deps, req(env), env.ctx)).ok);
    await env.store.close();
    const file = join(env.dir, CHAIN_LOG_FILE);
    const text = await readFile(file, 'utf8');
    assert.match(text, /"cursor":"cur_1"/);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, text.replace('"cursor":"cur_1"', '"cursor":"cur_9"'));

    const { EiStateStore } = await import('../src/index.js');
    const reopened = await EiStateStore.open({ dir: env.dir });
    if (reopened.ok) {
      const started = await reopened.value.start({
        grant: await (await import('./support/audit-grants.js')).readGrant(),
        trust: { principal: TEST_PRINCIPAL },
        inventory: new (await import('../src/index.js')).EnvironmentInventory(),
        ledger: new (await import('../src/index.js')).EvidenceLedger(),
      });
      assert.equal(started.ok, false, 'a tampered journal must not start');
      await reopened.value.close();
    } else {
      assert.equal(reopened.error.code, DiscoveryErrorCode.STATE_UNAVAILABLE);
    }
  });
});

test('STALE WRITER: a commit with the wrong expected sequence is rejected and changes nothing', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    const before = env.store.checkpointOf(r.value.binding);
    const stale = await env.store.commitIngestion(
      { principal: TEST_PRINCIPAL },
      {
        operationId: 'op_stale',
        sourceId: env.sourceId,
        binding: r.value.binding,
        expectedSeq: 0,
        cursor: 'cur_forged',
        complete: true,
        upserts: [],
        retire: [],
      },
    );
    assert.equal(stale.ok, false);
    // A FUTURE sequence has no duplicate-key backstop in the journal: only the sequence check stops it from writing a gap.
    const future = await env.store.commitIngestion(
      { principal: TEST_PRINCIPAL },
      {
        operationId: 'op_future',
        sourceId: env.sourceId,
        binding: r.value.binding,
        expectedSeq: (before?.seq ?? 0) + 2,
        cursor: 'cur_future',
        complete: true,
        upserts: [],
        retire: [],
      },
    );
    assert.equal(future.ok, false);
    assert.deepEqual(env.store.checkpointOf(r.value.binding), before);
    // Malformed resource digests are refused by the store itself, whatever the caller validated.
    for (const rd of ['short', 'Z'.repeat(24), 'a'.repeat(25)]) {
      const bad = await env.store.commitIngestion(
        { principal: TEST_PRINCIPAL },
        {
          operationId: 'op_badrd',
          sourceId: env.sourceId,
          binding: r.value.binding,
          expectedSeq: before?.seq ?? 0,
          complete: true,
          upserts: [{ rd, evidenceId: 'ev_' + 'a'.repeat(24) }],
          retire: [],
        },
      );
      assert.equal(bad.ok, false, `rd ${rd} must be refused`);
    }
    assert.deepEqual(env.store.checkpointOf(r.value.binding), before);
    await env.store.close();
  });
});

test('CLOSED STORE: a commit against a non-operational store mutates NOTHING, not even the in-memory ledger', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    const [rd, ids] = [...env.store.ingestedResources(env.sourceId).entries()][0] ?? [];
    assert.ok(rd !== undefined && ids !== undefined);
    const evidenceId = ids?.[0] as string;
    await env.store.close();
    const res = await env.store.commitIngestion(
      { principal: TEST_PRINCIPAL },
      {
        operationId: 'op_closed',
        sourceId: env.sourceId,
        binding: r.value.binding,
        expectedSeq: r.value.checkpoint?.seq ?? 0,
        complete: true,
        upserts: [],
        retire: [{ rd: rd as string, evidenceId, reason: 'deleted' }],
      },
    );
    assert.equal(res.ok, false);
    assert.notEqual(
      env.ledger.stateOf(evidenceId as EvidenceId),
      'purged',
      'the retirement was not applied to a store that cannot journal it',
    );
  });
});

test('CONCURRENCY: two simultaneous ingestions of one binding leave one consistent checkpoint chain and no stray quarantine', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const [a, b] = await Promise.all([ingestSource(env.deps, req(env), env.ctx), ingestSource(env.deps, req(env), env.ctx)]);
    const wins = [a, b].filter((x) => x.ok).length;
    assert.ok(wins >= 1);
    assert.equal(env.ledger.counts().quarantined, 0, 'no evidence of the winning batch was contained by the loser');
    assert.equal(env.ledger.counts().released, 2);
    await env.store.close();
  });
});

// ── revocation / authorization loss ───────────────────────────────────────────────────────────────────────────────────

class DenyingPort implements AuthorizationPort {
  denyRead = false;
  constructor(private readonly inner: AuthorizationPort) {}
  async decide(r: AuthorizationRequest): Promise<AuthorizationDecision> {
    if (this.denyRead && r.operation === 'incremental_sync') return mintDevelopmentDecision('deny', 'access revoked');
    return this.inner.decide(r);
  }
}

test('REVOCATION MID-SYNC (denial): stops, keeps the last good checkpoint, marks the source revoked, ingests nothing further', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    const port = new DenyingPort(env.authz);
    const ctx: ConnectorContext = { ...env.ctx, authorization: port };
    env.provider.set(undefined, { items: [{ key: 'a.txt', content: 'a' }], next: 'cur_1' });
    env.provider.set('cur_1', { items: [{ key: 'b.txt', content: 'b' }], next: 'cur_2' });
    env.provider.beforeAuthorize = (cursor) => {
      if (cursor === 'cur_1') port.denyRead = true; // access is withdrawn while the run is in progress
    };
    const r = await ingestSource(env.deps, req(env), ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'stopped');
    assert.equal(r.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
    assert.equal(r.value.sourceRevoked, true);
    assert.equal(r.value.batches, 1);
    assert.deepEqual(noProv(r.value.checkpoint), { seq: 1, cursor: 'cur_1', complete: false }, 'the last GOOD checkpoint stands');
    assert.equal(env.inventory.get(env.sourceId)?.axes.authorization, 'revoked');
    assert.equal(env.ledger.counts().released, 1, 'only the batch committed before the loss is retained');

    // Afterwards the source is refused up front: no read is even attempted.
    env.provider.reads.length = 0;
    port.denyRead = false;
    assert.equal(await codeOf(env, ctx), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env.provider.reads.length, 0);
    await env.store.close();
  });
});

test('REVOCATION MID-READ: authorization lost while the connector was reading discards and contains the in-flight batch', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'a.txt', content: 'a' }], next: 'cur_1' });
    env.provider.set('cur_1', { items: [{ key: 'secret.txt', content: 's' }], next: 'cur_2' });
    env.provider.afterAuthorize = (cursor) => {
      if (cursor === 'cur_1') env.inventory.apply(env.sourceId, 'authorization_revoked', env.clock.now().toISOString());
    };
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(r.value.stoppedBecause?.context?.['reason'], 'revoked_mid_sync');
    assert.equal(r.value.sourceRevoked, true);
    assert.deepEqual(noProv(r.value.checkpoint), { seq: 1, cursor: 'cur_1', complete: false });
    const ids = env.ledger.exportEntries();
    assert.equal(ids.filter((e) => e.state === 'released').length, 1, 'only the committed batch is eligible');
    assert.equal(ids.filter((e) => e.state === 'quarantined').length, 1, 'the in-flight batch was contained');
    assert.equal(env.store.ingestedResources(env.sourceId).size, 1);
    await env.store.close();
  });
});

// ── malformed / oversized / timeout ───────────────────────────────────────────────────────────────────────────────────

const refused = async (env: IngestEnv, code: string): Promise<void> => {
  const r = await ingestSource(
    env.deps,
    req(env, { limits: { batchTimeoutMs: 1000, maxEvidencePerBatch: 3, maxRemovedPerBatch: 2 } }),
    env.ctx,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, code);
  assert.equal(await noC4Records(env), true, 'a refused batch advances nothing');
  assert.equal(env.ledger.counts().released, 0, 'and leaves nothing eligible');
};

test('MALFORMED batches are discarded whole: contradictory, wrong-kind, bad removal entries, bad resource keys', async () => {
  const cases: [string, (e: IngestEnv) => void][] = [
    [
      'present and removed',
      (e) =>
        e.provider.set(undefined, { items: [{ key: 'a', content: '1' }], removed: [{ resourceKey: 'a', reason: 'deleted' }], next: 'c_1' }),
    ],
    ['wrong kind', (e) => e.provider.set(undefined, { items: [{ key: 'a', content: '1' }], kind: 'resource_inventory', next: 'c_1' })],
    ['empty resource key', (e) => e.provider.set(undefined, { items: [{ key: '', content: '1' }], next: 'c_1' })],
    ['huge resource key', (e) => e.provider.set(undefined, { items: [{ key: 'k'.repeat(2000), content: '1' }], next: 'c_1' })],
    ['NUL resource key', (e) => e.provider.set(undefined, { items: [{ key: 'a\u0000b', content: '1' }], next: 'c_1' })],
    [
      'removal with non-string key',
      (e) =>
        e.provider.set(undefined, {
          items: [{ key: 'a', content: '1' }],
          removed: JSON.parse('[{"resourceKey":7,"reason":"deleted"}]'),
          next: 'c_1',
        }),
    ],
    [
      'removal with unknown reason',
      (e) =>
        e.provider.set(undefined, {
          items: [{ key: 'a', content: '1' }],
          removed: JSON.parse('[{"resourceKey":"z","reason":"vanished"}]'),
          next: 'c_1',
        }),
    ],
    [
      'removal that is not an object',
      (e) => e.provider.set(undefined, { items: [{ key: 'a', content: '1' }], removed: JSON.parse('[null]'), next: 'c_1' }),
    ],
  ];
  for (const [name, arrange] of cases) {
    await withSandbox(async ({ base }) => {
      const env = await ingestEnv(base);
      arrange(env);
      await refused(env, DiscoveryErrorCode.MALFORMED_INPUT).catch((e: unknown) => {
        throw new Error(`case "${name}": ${(e as Error).message}`);
      });
      await env.store.close();
    });
  }
});

test('OVERSIZED batch (evidence or removals) is discarded and contained, never truncated', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: ['1', '2', '3', '4'].map((k) => ({ key: k, content: k })), next: 'c_1' });
    await refused(env, DiscoveryErrorCode.LIMIT_EXCEEDED);
    const quarantined = env.ledger.counts().quarantined;
    assert.equal(quarantined, 4, 'the whole oversized batch is quarantined');
    await env.store.close();
  });
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, {
      items: [],
      removed: ['a', 'b', 'c'].map((k) => ({ resourceKey: k, reason: 'deleted' as const })),
      next: 'c_1',
    });
    await refused(env, DiscoveryErrorCode.LIMIT_EXCEEDED);
    await env.store.close();
  });
});

test('LIMITS: unacceptable limits are refused up front; the batch cap ends a run with more_available', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    for (const limits of [{ maxBatches: 0 }, { maxEvidencePerBatch: 99999 }, { batchTimeoutMs: -1 }, { maxBatches: 1.5 }]) {
      assert.equal(await codeOf(env, env.ctx, { limits }), DiscoveryErrorCode.MALFORMED_INPUT);
    }
    assert.equal(env.provider.reads.length, 0);
    env.provider.set(undefined, { items: [{ key: 'a', content: 'a' }], next: 'c_1' });
    env.provider.set('c_1', { items: [{ key: 'b', content: 'b' }], next: 'c_2' });
    const r = await ingestSource(env.deps, req(env, { limits: { maxBatches: 2 } }), env.ctx);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.status, 'more_available');
      assert.equal(r.value.batches, 2);
      assert.equal(r.value.checkpoint?.cursor, 'c_2');
    }
    await env.store.close();
  });
});

test('PARTIAL batch: evidence is indexed but the cursor does NOT advance past incomplete data', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'a', content: 'a' }], status: 'partial', next: 'c_1' });
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'partial');
    assert.equal(r.value.checkpoint?.cursor, undefined, 'no cursor was committed');
    assert.equal(r.value.checkpoint?.complete, false);
    assert.equal(env.store.ingestedResources(env.sourceId).size, 1);
    await env.store.close();
  });
});

test('TIMEOUT: a batch that overruns its budget is discarded, the late result is ignored and nothing advances', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'a', content: 'a' }], next: 'c_1' });
    env.provider.afterAuthorize = () => new Promise((resolve) => setTimeout(resolve, 400));
    const r = await ingestSource(env.deps, req(env, { limits: { batchTimeoutMs: 40 } }), env.ctx);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, DiscoveryErrorCode.LIMIT_EXCEEDED);
      assert.equal(r.error.context?.['limit'], 'batch_timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the abandoned read finish
    assert.equal(await noC4Records(env), true, 'the late completion never produced a checkpoint');
    assert.equal(env.store.ingestedResources(env.sourceId).size, 0);
    // The abandoned read DID finish and the connector released its evidence; it is contained, not left eligible.
    assert.equal(env.ledger.counts().released, 0);
    assert.equal(env.ledger.counts().quarantined, 1);
    await env.store.close();
  });
});

// ── audit / state unavailable ─────────────────────────────────────────────────────────────────────────────────────────

test('AUDIT DOWN before the batch: the write-ahead attempt is refused, so nothing is read and nothing advances', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    env.recorder.refuse = () => true;
    assert.equal(await codeOf(env), DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.equal(env.provider.reads.length, 0);
    assert.equal(await noC4Records(env), true);
    assert.equal(env.ledger.counts().released, 0);
    await env.store.close();
  });
});

test('AUDIT DOWN for the connector read: the sync fails, the checkpoint does not move', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    env.recorder.refuse = (e) => JSON.stringify(e).includes('incremental_sync');
    assert.equal(await codeOf(env), DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.equal(await noC4Records(env), true);
    assert.equal(env.ledger.counts().released, 0);
    await env.store.close();
  });
});

test('AUDIT DOWN for the ingestion terminal record: the batch is NOT reported ingested (documented: the commit already happened)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    let seenIngestAttempt = false;
    env.recorder.refuse = (e) => {
      const text = JSON.stringify(e);
      if (text.includes('ingest_source') && !seenIngestAttempt) {
        seenIngestAttempt = true;
        return false; // the write-ahead attempt is accepted
      }
      return text.includes('ingest_source'); // the terminal record is refused
    };
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.equal(r.ok, false, 'the caller is told the batch could not be completed');
    if (!r.ok) {
      assert.equal(r.error.code, DiscoveryErrorCode.AUDIT_UNAVAILABLE);
      assert.equal(r.error.context?.['committed'], true, 'and told the truth: the checkpoint DID commit');
      assert.equal(typeof r.error.context?.['checkpointSeq'], 'number');
    }
    // Re-running is a no-op: nothing is duplicated and the cursor is not re-advanced.
    env.recorder.refuse = undefined;
    const again = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(again.ok);
    assert.equal(env.ledger.counts().released, 2);
    await env.store.close();
  });
});

test('STATE DOWN: a closed store refuses ingestion before any read', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    await env.store.close();
    assert.equal(await codeOf(env), DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(env.provider.reads.length, 0);
  });
});

test('SECRET NON-LEAKAGE: errors, audit events and results carry no provider content, resource keys or paths', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, {
      items: [{ key: 'classified-file-name.txt', content: 'BODY-SECRET-123' }],
      removed: JSON.parse('[{"resourceKey":"x-secret-key","reason":"nope"}]'),
      next: 'c_1',
    });
    const r = await ingestSource(env.deps, req(env), env.ctx);
    const blob = JSON.stringify(r) + JSON.stringify(env.recorder.inner.events ?? []);
    for (const forbidden of ['classified-file-name', 'BODY-SECRET-123', 'x-secret-key', '/scripted/finance-share']) {
      assert.equal(blob.includes(forbidden), false, `must not leak "${forbidden}"`);
    }
    await env.store.close();
  });
});

test('REGRESSION: batches are not required to carry `removed` (connectors written before C4 behave exactly as before)', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    simple(env);
    const r = await ingestSource(env.deps, req(env), env.ctx);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.retired.length, 0);
    const ids = env.ledger
      .exportEntries()
      .filter((e) => e.state === 'released')
      .map((e) => e.id as EvidenceId);
    assert.equal(ids.length, 2);
    await env.store.close();
  });
});

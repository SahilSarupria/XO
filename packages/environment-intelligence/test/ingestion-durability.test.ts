/**
 * C4 - crash / resume at every checkpoint phase, durable containment, journal compatibility and regression of existing connectors.
 *
 * KIND OF TEST: OFFLINE CONTRACT tests (scripted provider, real EI components, real on-disk journal with injected write/fsync faults),
 * plus one MOCKED INTEGRATION test that serves the shared in-memory `MockConnector` through `ingestSource`. No live provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAIN_LOG_FILE, ChainedAuditStore, actorFromPrincipal } from '@xo/audit';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EI_STATE_EXTENSION_SCHEMA,
  EI_STATE_NAMESPACE,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  discoverSource,
  ingestSource,
  syncSource,
  type ConnectorContext,
  type DiscoveryDeps,
  type EvidenceId,
} from '../src/index.js';
import { TEST_PRINCIPAL, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';
import { MOCK_SOURCE_TYPE, MockConnector, type MockScope } from './support/mock-connector.js';
import { allowing } from './support/scripted-authorization.js';
import { SCOPE, ingestEnv, type IngestEnv, type ScriptedProvider } from './support/scripted-sync.js';
import { faultOps, recIs } from './support/state-fixtures.js';

const request = (env: IngestEnv) => ({ sourceId: env.sourceId, kind: 'document_content' as const, scope: SCOPE });

const pages = (p: ScriptedProvider): void => {
  p.set(undefined, {
    items: [
      { key: 'a.txt', content: 'alpha' },
      { key: 'b.txt', content: 'beta' },
    ],
    next: 'cur_1',
  });
  p.set('cur_1', { items: [{ key: 'c.txt', content: 'gamma' }], next: 'cur_2' });
  p.set('cur_2', { items: [], next: 'cur_2' });
};

/** The externally observable end state: which evidence is in which state, and what the resource index holds. */
const endState = (env: IngestEnv) => ({
  ledger: env.ledger
    .exportEntries()
    .map((e) => `${e.id}:${e.state}`)
    .sort(),
  index: [...env.store.ingestedResources(env.sourceId).entries()].map(([rd, ids]) => `${rd}=${ids.join(',')}`).sort(),
});

async function cleanRun(base: string, arrange: (p: ScriptedProvider) => void): Promise<ReturnType<typeof endState>> {
  const env = await ingestEnv(join(base, 'clean'));
  arrange(env.provider);
  const r = await ingestSource(env.deps, request(env), env.ctx);
  assert.ok(r.ok);
  const s = endState(env);
  await env.store.close();
  return s;
}

const mustOk = async (env: IngestEnv): Promise<void> => {
  const r = await ingestSource(env.deps, request(env), env.ctx);
  assert.ok(r.ok, r.ok ? '' : r.error.code);
};

test('CRASH P1 (connector released, checkpoint write fails): nothing advances; after restart the replay reaches the uninterrupted end state', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base, { ops: faultOps(recIs('checkpoint'), 'failWrite') });
    pages(env.provider);
    const r = await ingestSource(env.deps, request(env), env.ctx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(env.store.checkpointOf('0'.repeat(64)), undefined);
    assert.equal(env.ledger.counts().released, 0, 'the failed store is not an authority: nothing is eligible from it');
    await env.store.close();

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal([...again.store.ingestedResources(env.sourceId).values()].length, 0, 'no checkpoint and no index survived the crash');
    again.provider.reads.length = 0;
    await mustOk(again);
    assert.equal(again.provider.reads[0], undefined, 'resumed from the beginning: no cursor had been committed');
    assert.deepEqual(endState(again), await cleanRun(join(base, 'x'), pages));
    await again.store.close();
  });
});

test('CRASH P2 (checkpoint bytes landed, fsync unconfirmed): after restart the journal decides; resume continues from that cursor, not from the start', async () => {
  await withSandbox(async ({ base }) => {
    let armed = false;
    const env = await ingestEnv(base, { ops: faultOps((l) => armed && recIs('checkpoint')(l), 'failSync') });
    pages(env.provider);
    armed = true;
    const r = await ingestSource(env.deps, request(env), env.ctx);
    assert.equal(r.ok, false, 'an indeterminate write is never reported as success');
    await env.store.close();

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    again.provider.reads.length = 0;
    await mustOk(again);
    assert.equal(again.provider.reads[0], 'cur_1', 'the landed checkpoint was honoured');
    assert.deepEqual(endState(again), await cleanRun(join(base, 'x'), pages));
    await again.store.close();
  });
});

test('CRASH P3 (supersede: tombstone durable, checkpoint write fails): old version stays retired; replay completes without resurrecting it', async () => {
  await withSandbox(async ({ base }) => {
    let armed = false;
    const env = await ingestEnv(base, { ops: faultOps((l) => armed && recIs('checkpoint')(l), 'failWrite') });
    env.provider.set(undefined, { items: [{ key: 'p.txt', content: 'v1' }], next: 'cur_1' });
    env.provider.set('cur_1', { items: [], next: 'cur_1' });
    await mustOk(env);
    const v1 = [...env.store.ingestedResources(env.sourceId).values()][0]?.[0] as EvidenceId;
    env.provider.set('cur_1', { items: [{ key: 'p.txt', content: 'v2' }], next: 'cur_2' });
    env.provider.set('cur_2', { items: [], next: 'cur_2' });
    armed = true;
    const r = await ingestSource(env.deps, request(env), env.ctx);
    assert.equal(r.ok, false);
    await env.store.close();

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(again.ledger.isEligible(v1), false, 'the journaled tombstone survived');
    await mustOk(again);
    const only = [...again.store.ingestedResources(env.sourceId).values()].flat();
    assert.equal(only.length, 1);
    assert.notEqual(only[0], v1);
    assert.equal(again.ledger.isEligible(only[0] as EvidenceId), true);
    assert.equal(again.ledger.isEligible(v1), false);
    await again.store.close();
  });
});

test('CRASH P4 (tombstone write fails): the store fails closed; after restart the replay re-derives and applies the retirement', async () => {
  await withSandbox(async ({ base }) => {
    let armed = false;
    const env = await ingestEnv(base, { ops: faultOps((l) => armed && recIs('tombstone')(l), 'failWrite') });
    env.provider.set(undefined, {
      items: [
        { key: 'x.txt', content: 'x' },
        { key: 'y.txt', content: 'y' },
      ],
      next: 'cur_1',
    });
    env.provider.set('cur_1', { items: [], next: 'cur_1' });
    await mustOk(env);
    env.provider.set('cur_1', { items: [], removed: [{ resourceKey: 'x.txt', reason: 'deleted' }], next: 'cur_2' });
    env.provider.set('cur_2', { items: [], next: 'cur_2' });
    armed = true;
    const r = await ingestSource(env.deps, request(env), env.ctx);
    assert.equal(r.ok, false);
    await env.store.close();

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(
      again.store.ingestedResources(env.sourceId).size,
      2,
      'the un-journaled retirement did not survive: the journal is the truth',
    );
    await mustOk(again);
    assert.equal(again.store.ingestedResources(env.sourceId).size, 1);
    assert.equal(again.ledger.counts().purged, 1);
    assert.equal(again.ledger.counts().released, 1);
    await again.store.close();
  });
});

test('CRASH between batches: a run interrupted after batch 1 resumes at batch 2 with the same final state', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    pages(env.provider);
    const first = await ingestSource(env.deps, { ...request(env), limits: { maxBatches: 1 } }, env.ctx);
    assert.ok(first.ok);
    if (first.ok) assert.equal(first.value.status, 'more_available');
    await env.store.close(); // process dies here

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    again.provider.reads.length = 0;
    await mustOk(again);
    assert.equal(again.provider.reads[0], 'cur_1');
    assert.deepEqual(endState(again), await cleanRun(join(base, 'x'), pages));
    await again.store.close();
  });
});

test('QUARANTINE is durable: a discarded batch stays ineligible across a restart and is never indexed', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, {
      items: [
        { key: 'a', content: 'a' },
        { key: 'b', content: 'b' },
      ],
      next: 'has space',
    });
    const r = await ingestSource(env.deps, request(env), env.ctx);
    assert.equal(r.ok, false);
    assert.equal(env.ledger.counts().quarantined, 2);
    await env.store.close();
    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(again.ledger.counts().quarantined, 2);
    assert.equal(again.ledger.counts().released, 0);
    assert.equal(again.store.ingestedResources(env.sourceId).size, 0);
    await again.store.close();
  });
});

test('C1 HARDENING: plain syncSource with an unacceptable nextCursor now quarantines the batch it rejected', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base);
    env.provider.set(undefined, { items: [{ key: 'a', content: 'a' }], next: 'has space' });
    const r = await syncSource(env.deps, { sourceId: env.sourceId, kind: 'document_content', scope: SCOPE }, env.ctx);
    assert.equal(r.ok, false);
    assert.equal(env.ledger.counts().released, 0);
    assert.equal(env.ledger.counts().quarantined, 1);
    await env.store.close();
  });
});

test('COMPATIBILITY: a journal holding only pre-C4 records opens unchanged and checkpoints append onto the same chain', async () => {
  await withSandbox(async ({ base }) => {
    const env = await ingestEnv(base); // discovery only: source + intent/release records, no checkpoint
    const before = await readFile(join(env.dir, CHAIN_LOG_FILE), 'utf8');
    assert.equal(/"rec":"(checkpoint|tombstone)"/.test(before), false);
    const recordsBefore = env.store.diagnostics().records;
    await env.store.close();

    const again = await ingestEnv(base, { provider: env.provider, skipDiscover: true });
    assert.equal(again.store.diagnostics().records, recordsBefore, 'recovery of a pre-C4 journal is unchanged');
    assert.equal(again.store.ingestedResources(env.sourceId).size, 0);
    pages(again.provider);
    await mustOk(again);
    const after = await readFile(join(again.dir, CHAIN_LOG_FILE), 'utf8');
    assert.ok(after.startsWith(before), 'the pre-C4 prefix is byte-identical: C4 only appends');
    assert.match(after, /"rec":"checkpoint"/);
    await again.store.close();
  });
});

test('REGRESSION (mocked integration): the shared MockConnector, written before C4 and unaware of `removed`, ingests through ingestSource', async () => {
  await withSandbox(async ({ base }) => {
    const connector = new MockConnector({ sync: true });
    const registry = new ConnectorRegistry();
    registry.register(connector);
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    const clock = new MockClock('2026-10-10T00:00:00.000Z');
    const opened = await EiStateStore.open({ dir: join(base, 'state') });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const started = await opened.value.start({ grant: await readGrant(), trust: { principal: TEST_PRINCIPAL }, inventory, ledger });
    assert.ok(started.ok);
    const authorization = allowing(['filesystem.list', 'filesystem.read', 'data.write']);
    const ctx: ConnectorContext = {
      clock,
      authorization,
      principal: TEST_PRINCIPAL,
      audit: new InMemoryAuditRecorder(() => clock.now()),
      ledger,
      state: opened.value,
    };
    const deps: DiscoveryDeps = { registry, inventory };
    const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };
    const found = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.ok(found.ok);
    if (!found.ok) return;
    const sourceId = found.value.record.source.sourceId;
    const releasedByDiscovery = ledger.counts().released;
    const r = await ingestSource(deps, { sourceId, kind: 'document_content', scope }, ctx);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.items.length, 2);
      assert.equal(r.value.status, 'caught_up');
    }
    assert.equal(ledger.counts().released, releasedByDiscovery + 2);
    await opened.value.close();
  });
});

test('REGRESSION: a connector that does not support sync is refused cleanly (no state, no read)', async () => {
  await withSandbox(async ({ base }) => {
    const connector = new MockConnector({ sync: false });
    const registry = new ConnectorRegistry();
    registry.register(connector);
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    const clock = new MockClock('2026-10-10T00:00:00.000Z');
    const opened = await EiStateStore.open({ dir: join(base, 'state') });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    await opened.value.start({ grant: await readGrant(), trust: { principal: TEST_PRINCIPAL }, inventory, ledger });
    const ctx: ConnectorContext = {
      clock,
      authorization: allowing(['filesystem.list', 'filesystem.read', 'data.write']),
      principal: TEST_PRINCIPAL,
      audit: new InMemoryAuditRecorder(() => clock.now()),
      ledger,
      state: opened.value,
    };
    const deps: DiscoveryDeps = { registry, inventory };
    const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };
    const found = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.ok(found.ok);
    if (!found.ok) return;
    connector.calls.length = 0;
    const r = await ingestSource(deps, { sourceId: found.value.record.source.sourceId, kind: 'document_content', scope }, ctx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
    assert.deepEqual(connector.calls, []);
    const recorder = ctx.audit;
    assert.ok(recorder instanceof InMemoryAuditRecorder);
    assert.equal(
      recorder.events().filter((e) => e.operation === 'ingest_source').length,
      0,
      'no ingestion attempt is opened for a connector that cannot sync',
    );
    await opened.value.close();
  });
});

/** Appends one hand-built checkpoint record to an EXISTING journal through the real, correctly chaining store (so the chain stays valid). */
async function appendCheckpointRecord(dir: string, sourceId: string, binding: string, cseq: number, key: string): Promise<void> {
  const store = await ChainedAuditStore.open({
    dir,
    extensionSchemas: { [EI_STATE_NAMESPACE]: EI_STATE_EXTENSION_SCHEMA },
    creationMarker: true,
  });
  assert.ok(store.ok, 'the journal must open for the crafted append');
  if (!store.ok) return;
  const appended = await store.value.append({
    type: 'environment.completed',
    action: 'ei-state.checkpoint',
    outcome: 'completed',
    actor: actorFromPrincipal(TEST_PRINCIPAL),
    correlationId: `op_crafted_${cseq}`,
    idempotencyKey: key,
    extensions: {
      [EI_STATE_NAMESPACE]: {
        rec: 'checkpoint',
        sourceId,
        operationId: `op_crafted_${cseq}`,
        cp: { cseq, binding, complete: true },
        pairs: [],
      },
    },
  });
  assert.ok(
    appended.ok,
    `the crafted record itself is schema-valid and correctly chained: ${appended.ok ? '' : JSON.stringify(appended.error)}`,
  );
  await store.value.close();
}

const cseqKey = (name: string): string => name.replace(/[^a-z]/g, '').slice(0, 12);

const startAt = async (dir: string) => {
  const opened = await EiStateStore.open({ dir });
  assert.ok(opened.ok);
  if (!opened.ok) throw new Error('unreachable');
  const started = await opened.value.start({
    grant: await readGrant(),
    trust: { principal: TEST_PRINCIPAL },
    inventory: new EnvironmentInventory(),
    ledger: new EvidenceLedger(),
  });
  return { started, store: opened.value };
};

test('FOLD: a checkpoint sequence gap or repeat in an otherwise VALID, correctly chained journal is corruption (positive control included)', async () => {
  for (const [name, delta, mustStart] of [
    ['next sequence (control)', 1, true],
    ['gap', 5, false],
    ['repeat', 0, false],
    ['rewind', -1, false],
  ] as const) {
    await withSandbox(async ({ base }) => {
      const env = await ingestEnv(base);
      pages(env.provider);
      const r = await ingestSource(env.deps, request(env), env.ctx);
      assert.ok(r.ok);
      if (!r.ok) return;
      const seq = r.value.checkpoint?.seq ?? 0;
      await env.store.close();
      await appendCheckpointRecord(env.dir, env.sourceId, r.value.binding, seq + delta, `cpt:crafted:${cseqKey(name)}`);
      const { started, store } = await startAt(env.dir);
      assert.equal(
        started.ok,
        mustStart,
        `${name}: a ${mustStart ? 'consistent' : 'discontinuous'} sequence must ${mustStart ? 'start' : 'be refused'}`,
      );
      if (started.ok) assert.equal(store.checkpointOf(r.value.binding)?.seq, seq + 1);
      await store.close();
    });
  }
});

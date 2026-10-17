/**
 * C0.4 — durable EI lifecycle state. Written BEFORE the implementation; each test names the crash-matrix row or
 * owner decision it proves (docs/environment-intelligence/c0-4-state-journal.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { CHAIN_INIT_MARKER, CHAIN_LOG_FILE, defaultFileOps, readClosedChainedLog, type AuditEvent, type FileOps } from '@xo/audit';
import {
  ConnectorId,
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceId,
  EvidenceLedger,
  EiStateStore,
  EI_STATE_NAMESPACE,
  EI_STATE_EXTENSION_SCHEMA,
  EI_AUDIT_EXTENSION_SCHEMA,
  EI_AUDIT_NAMESPACE,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  ConnectorRegistry,
  PermissionManagerAuthorization,
  SourceId,
  acquireSourceContent,
  crossCheckState,
  discoverSource,
  openEiAuditStore,
  purgeSourceEvidence,
  revokeSourceEvidence,
  type AuditTrust,
  type ConnectorContext,
  type DetectedSource,
  type DiscoveryDeps,
  type Evidence,
  type FilesystemScope,
} from '../src/index.js';
import { TEST_PRINCIPAL, allowRoot, authenticated, ctxFor, put, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';

const T = '2026-10-12T00:00:00.000Z';
const OP = authenticated('operator-1');
const trust: AuditTrust = { principal: OP };
const hex = (c: string, n: number): string => c.repeat(n).slice(0, n);
const SRC = 'src_' + hex('a', 24);
const SRC2 = 'src_' + hex('b', 24);
const ev = (n: number, sourceId = SRC): Evidence =>
  ({
    id: EvidenceId(`ev_${String(n).padStart(24, '0')}`),
    kind: 'resource_inventory',
    sourceId: SourceId(sourceId),
    resourceKey: '',
    payload: {},
    sensitivity: 'metadata',
    provenance: {
      sourceId: SourceId(sourceId),
      connectorId: ConnectorId('xo.local-filesystem'),
      connectorVersion: '1',
      locator: '',
      observedAt: T,
      access: { operation: 'discover', permission: 'filesystem.list', authority: 'platform', decisionReason: 'test' },
      transformationChain: [],
    },
  }) as unknown as Evidence;
const source = (sourceId = SRC): DetectedSource => ({
  sourceId: SourceId(sourceId),
  sourceType: 'local_filesystem',
  displayName: 'Quarterly Finance Share',
  locator: '/home/alice/secret-project/finance',
  detectedBy: ConnectorId('xo.local-filesystem'),
  detectedAt: T,
  fingerprint: hex('c', 64),
});

interface Booted {
  store: EiStateStore;
  inventory: EnvironmentInventory;
  ledger: EvidenceLedger;
  started: Awaited<ReturnType<EiStateStore['start']>>;
}
async function boot(dir: string, over: Partial<Parameters<typeof EiStateStore.open>[0]> = {}): Promise<Booted> {
  const opened = await EiStateStore.open({ dir, ...over });
  assert.ok(opened.ok, `open must succeed (${opened.ok ? '' : opened.error.code})`);
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  if (!opened.ok) throw new Error('unreachable');
  const started = await opened.value.start({ grant: await readGrant(), trust, inventory, ledger });
  return { store: opened.value, inventory, ledger, started };
}
function seed(b: Booted, sourceId = SRC): void {
  b.inventory.observe(source(sourceId), T);
  b.inventory.apply(SourceId(sourceId), 'connector_matched', T, { connectorId: ConnectorId('xo.local-filesystem') });
  b.inventory.apply(SourceId(sourceId), 'connection_configured', T);
  b.inventory.apply(SourceId(sourceId), 'authorization_granted', T);
  b.inventory.apply(SourceId(sourceId), 'connection_validated', T);
  b.inventory.apply(SourceId(sourceId), 'acquisition_succeeded', T);
}
const raw = (dir: string): Promise<string> => readFile(join(dir, CHAIN_LOG_FILE), 'utf8');
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Wraps FileOps: `failWrite` throws BEFORE any byte lands; `failSync` lets the bytes land and then fails the fsync. */
function faultOps(match: (line: string) => boolean, mode: 'failWrite' | 'failSync' | 'half'): FileOps {
  const wrap = (h: Awaited<ReturnType<FileOps['openAppend']>>) => {
    let last = '';
    return {
      write: async (d: Buffer) => {
        last = d.toString();
        if (mode === 'failWrite' && match(last)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        if (mode === 'half' && match(last)) {
          await h.write(d.subarray(0, Math.floor(d.length / 2)));
          throw Object.assign(new Error('crash'), { code: 'EIO' });
        }
        await h.write(d);
      },
      sync: async () => {
        if (mode === 'failSync' && match(last)) throw Object.assign(new Error('fsync'), { code: 'EIO' });
        await h.sync();
      },
      close: () => h.close(),
    };
  };
  return {
    ...defaultFileOps,
    openAppend: async (p) => wrap(await defaultFileOps.openAppend(p)),
    openNew: async (p) => wrap(await defaultFileOps.openNew(p)),
  };
}
const recIs =
  (rec: string) =>
  (line: string): boolean =>
    line.includes(`"rec":"${rec}"`);

// ───────────────────────────── release ─────────────────────────────

test('RELEASE: confirmed releases survive a restart exactly (state, source, operation); the in-memory ledger equals the journal', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    assert.ok(a.started.ok);
    assert.equal(a.store.operational, true);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1), ev(2)])).ok);
    assert.ok((await a.store.release(trust, 'op_2', [ev(3, SRC2)])).ok);
    assert.deepEqual(a.ledger.counts(), { released: 3, quarantined: 0, revoked: 0, purged: 0 });
    await a.store.close();

    const b = await boot(dir);
    assert.ok(b.started.ok);
    assert.deepEqual(b.ledger.counts(), { released: 3, quarantined: 0, revoked: 0, purged: 0 });
    assert.equal(b.ledger.isEligible(ev(1).id), true);
    assert.deepEqual(b.ledger.idsOf(SourceId(SRC2), ['released']), [ev(3, SRC2).id]);
    assert.equal(b.inventory.get(SourceId(SRC))?.axes.acquisition, 'succeeded');
    await b.store.close();
  });
});

test('FAIL-CLOSED: before start(), after a failed start, and after close, NOTHING is eligible — even ids the ledger holds as released', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    assert.equal(a.ledger.isEligible(ev(1).id), true);
    await a.store.close();
    assert.equal(a.ledger.isEligible(ev(1).id), false, 'closed store: the gate denies everything');

    const opened = await EiStateStore.open({ dir });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const ledger = new EvidenceLedger();
    const forged = await opened.value.start({
      grant: { kind: 'xo.audit.access-grant', action: 'read' },
      trust,
      inventory: new EnvironmentInventory(),
      ledger,
    });
    assert.ok(!forged.ok && forged.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE, 'a forged grant cannot start the store');
    assert.equal(opened.value.operational, false);
    assert.equal(ledger.isEligible(ev(1).id), false);
    assert.ok(!(await opened.value.release(trust, 'op_9', [ev(9)])).ok, 'a non-operational store refuses writes');
    await opened.value.close();
  });
});

test('RELEASE indeterminate (fsync fails after the bytes landed): everything becomes ineligible; after restart the record is found and a retry by operationId is a duplicate', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir, { ops: faultOps(recIs('release'), 'failSync') });
    assert.ok(a.started.ok);
    assert.ok((await a.store.release(trust, 'op_pre', [ev(1)])).ok === false, 'positive control: the failing ops hit the first release');
    // (the first release above already failed; the store is non-operational)
    assert.equal(a.store.operational, false);
    assert.equal(a.ledger.isEligible(ev(1).id), false, 'withheld in memory');
    await a.store.close();

    const b = await boot(dir);
    assert.ok(b.started.ok);
    assert.equal(b.ledger.stateOf(ev(1).id), 'released', 'the record had landed, so it is durable and eligible (undelivered — harmless)');
    const retry = await b.store.release(trust, 'op_pre', [ev(1)]);
    assert.ok(retry.ok, 'idempotent retry by the same operationId');
    assert.equal((await raw(dir)).split('\n').filter((l) => l.includes('"rec":"release"')).length, 1, 'exactly one release record');
    await b.store.close();
  });
});

test('RELEASE write failure with NO bytes landed: evidence withheld, store non-operational, nothing durable; retry after restart writes it once', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir, { ops: faultOps(recIs('release'), 'failWrite') });
    const r = await a.store.release(trust, 'op_x', [ev(7)]);
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(a.ledger.isEligible(ev(7).id), false);
    assert.equal(a.store.operational, false, 'unavailable storage fails closed');
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(7).id), undefined, 'nothing durable, nothing released');
    assert.ok((await b.store.release(trust, 'op_x', [ev(7)])).ok);
    assert.equal(b.ledger.isEligible(ev(7).id), true);
    await b.store.close();
  });
});

test('RELEASE rejected (same operation, different evidence = conflict): nothing written, evidence withheld, store STAYS operational', async () => {
  await withSandbox(async ({ base }) => {
    const a = await boot(join(base, 'state'));
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    const conflict = await a.store.release(trust, 'op_1', [ev(2)]);
    assert.ok(
      !conflict.ok && conflict.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE && conflict.error.context['outcome'] === 'rejected',
    );
    assert.equal(a.ledger.isEligible(ev(2).id), false);
    assert.equal(a.store.operational, true, 'a definite rejection wrote nothing and does not poison the store');
    assert.equal(a.ledger.isEligible(ev(1).id), true);
    await a.store.close();
  });
});

// ───────────────────────────── revoke / purge ─────────────────────────────

test('REVOKE crash after intent, before the transition: restart REPLAYS it as a revoke — evidence is never eligible again', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1), ev(2)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) })).ok);
    await a.store.close(); // crash: the revoke was never applied or journaled

    const b = await boot(dir);
    assert.ok(b.started.ok && b.started.value.reconciledIntents === 1);
    assert.deepEqual(b.ledger.counts(), { released: 0, quarantined: 0, revoked: 2, purged: 0 });
    assert.equal(b.inventory.get(SourceId(SRC))?.axes.authorization, 'revoked');
    assert.equal(b.ledger.isEligible(ev(1).id), false);
    assert.equal(b.store.diagnostics().openIntents.length, 0);
    await b.store.close();
    const c = await boot(dir);
    assert.ok(
      c.started.ok && c.started.value.reconciledIntents === 0,
      'the replay was itself journaled; a second restart has nothing to replay',
    );
    assert.equal(c.ledger.counts().revoked, 2);
    await c.store.close();
  });
});

test('REVOKE crash BEFORE the intent: nothing changed — evidence is still eligible and no phantom revocation appears', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir, { ops: faultOps(recIs('intent'), 'failWrite') });
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    const begun = await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) });
    assert.ok(!begun.ok, 'the intent could not be journaled');
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.isEligible(ev(1).id), true);
    assert.equal(b.started.ok && b.started.value.reconciledIntents, 0);
    await b.store.close();
  });
});

test('REVOKE journaled: durable across restart; applying it twice is idempotent; an indeterminate transition still ends revoked after restart', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir, { ops: faultOps(recIs('transition'), 'failSync') });
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) })).ok);
    const applied = await a.store.applyRevoke(trust, { operationId: 'op_rev', sourceId: SourceId(SRC), at: T });
    assert.ok(!applied.ok, 'the transition write is indeterminate');
    assert.equal(a.ledger.stateOf(ev(1).id), 'revoked', 'memory is revoked FIRST (the safe direction)');
    assert.equal(a.store.operational, false);
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(1).id), 'revoked', 'whether or not the transition landed, restart ends revoked');
    assert.ok((await b.store.applyRevoke(trust, { operationId: 'op_rev', sourceId: SourceId(SRC), at: T })).ok, 'idempotent');
    assert.equal(b.ledger.counts().revoked, 1);
    await b.store.close();
  });
});

test('PURGE: a purge intent is replayed as a REVOKE ONLY (never as purged); `purged` exists only after applyPurge; retry completes', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'purge', operationId: 'op_purge', sourceId: SourceId(SRC) })).ok);
    await a.store.close(); // crash before anything else

    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(1).id), 'revoked', 'replayed as revoke');
    assert.notEqual(b.ledger.stateOf(ev(1).id), 'purged', 'recovery never claims a purge');
    assert.equal(b.inventory.get(SourceId(SRC))?.purgeRequired, true, 'the purge obligation survives');
    assert.deepEqual(b.store.diagnostics().openIntents, ['op_purge'], 'the unfinished purge is reported');
    // retry the purge with the same operationId (targets are external and idempotent)
    assert.ok(
      (await b.store.beginLifecycle(trust, { kind: 'purge', operationId: 'op_purge', sourceId: SourceId(SRC) })).ok,
      'idempotent intent',
    );
    assert.ok((await b.store.applyPurge(trust, { operationId: 'op_purge', sourceId: SourceId(SRC), at: T })).ok);
    assert.equal(b.ledger.stateOf(ev(1).id), 'purged');
    assert.equal(b.inventory.get(SourceId(SRC))?.purgeRequired, false);
    assert.deepEqual(b.store.diagnostics().openIntents, []);
    await b.store.close();
    const c = await boot(dir);
    assert.equal(c.ledger.stateOf(ev(1).id), 'purged');
    assert.equal(c.inventory.get(SourceId(SRC))?.purgeRequired, false);
    await c.store.close();
  });
});

// ───────────────────────────── inventory, schema, secrets ─────────────────────────────

test('INVENTORY: source state survives restart; locator, display name, errors and history are NOT persisted; repeated sync writes nothing', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    a.inventory.apply(SourceId(SRC), 'source_unavailable', T, {
      error: {
        code: DiscoveryErrorCode.SOURCE_UNAVAILABLE,
        message: 'cannot open /home/alice/secret-project/finance: password=hunter2',
        retryable: true,
        context: { path: '/home/alice/secret-project' },
      },
    });
    const first = await a.store.syncInventory(trust);
    assert.ok(first.ok && first.value.written === 1);
    const again = await a.store.syncInventory(trust);
    assert.ok(again.ok && again.value.written === 0, 'unchanged state is not re-journaled');
    await a.store.close();

    const text = await raw(dir);
    for (const needle of [
      '/home/alice',
      'secret-project',
      'Quarterly Finance Share',
      'hunter2',
      'cannot open',
      'locator',
      'displayName',
      'message',
      'history',
    ]) {
      assert.ok(!text.includes(needle), `the journal must not contain ${needle}`);
    }
    const b = await boot(dir);
    const rec = b.inventory.get(SourceId(SRC));
    assert.ok(rec !== undefined);
    assert.equal(rec?.source.locator, '', 'locator is empty until re-detection');
    assert.equal(rec?.source.displayName, '');
    assert.equal(rec?.axes.unavailable, true);
    assert.equal(rec?.lastError?.code, DiscoveryErrorCode.SOURCE_UNAVAILABLE);
    assert.equal(rec?.lastError?.message, '', 'only code and retryable survive');
    assert.deepEqual(rec?.lastError?.context, {});
    assert.deepEqual(rec?.history, []);
    assert.equal(rec?.source.fingerprint, hex('c', 64));
    await b.store.close();
  });
});

test('SCHEMA / SECRETS: forged principal and unauthenticated trust record nothing; the closed schema and the global filter apply', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    const snapshot = { principal: { kind: 'human', id: 'operator-1' } } as unknown as AuditTrust;
    assert.ok(!(await a.store.release(snapshot, 'op_f', [ev(1)])).ok, 'a structural copy of a principal is not trust');
    assert.ok(!(await a.store.release(undefined as unknown as AuditTrust, 'op_f', [ev(1)])).ok);
    assert.ok(!(await a.store.release(trust, 'Bearer abcdefghijklmnop0123456789', [ev(1)])).ok, 'a secret-shaped operation id is refused');
    assert.ok(
      !(await a.store.release(trust, 'op_g', [{ ...ev(1), id: EvidenceId('ev_/etc/passwd') } as Evidence])).ok,
      'a path-shaped evidence id is refused',
    );
    assert.equal((await raw(dir)).split('\n').filter((l) => l.includes('"rec"')).length, 0, 'nothing reached the journal');
    assert.equal(a.ledger.isEligible(ev(1).id), false);
    assert.ok(EI_STATE_EXTENSION_SCHEMA.namespace === EI_STATE_NAMESPACE);
    await a.store.close();
  });
});

test('SCHEMA: a persisted record with an extra field or a sensitive value is corruption even if the chain was re-hashed (unkeyed chain)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    await a.store.close();
    const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
    const sort = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sort)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as object)
                .filter(([, x]) => x !== undefined)
                .sort(([x], [y]) => (x < y ? -1 : 1))
                .map(([k, x]) => [k, sort(x)]),
            )
          : v;
    const lines = (await raw(dir)).split('\n').filter(Boolean);
    let prev = '0'.repeat(64);
    const out = lines.map((l) => {
      const rec = JSON.parse(l) as Record<string, any>;
      if (rec['kind'] === 'event') rec['event']['extensions'][EI_STATE_NAMESPACE]['locator'] = '/home/alice/secret';
      rec['prevHash'] = prev;
      delete rec['hash'];
      rec['hash'] = sha(JSON.stringify(sort(rec)));
      prev = rec['hash'];
      return JSON.stringify(rec);
    });
    await writeFile(join(dir, CHAIN_LOG_FILE), `${out.join('\n')}\n`);
    const reopened = await EiStateStore.open({ dir });
    assert.ok(!reopened.ok && reopened.error.context['outcome'] === 'corrupt');
  });
});

test('CORRUPTION: modify / delete / reorder of the journal fails closed at open — no state is ever served from a damaged journal', async () => {
  for (const mutate of [
    (ls: string[]) => ls.map((l, i) => (i === 1 ? l.replace('op_1', 'op_9') : l)),
    (ls: string[]) => ls.filter((_, i) => i !== 1),
    (ls: string[]) => [ls[0]!, ls[2]!, ls[1]!, ...ls.slice(3)],
  ]) {
    await withSandbox(async ({ base }) => {
      const dir = join(base, 'state');
      const a = await boot(dir);
      assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
      assert.ok((await a.store.release(trust, 'op_2', [ev(2)])).ok);
      await a.store.close();
      const ls = (await raw(dir)).split('\n').filter(Boolean);
      await writeFile(join(dir, CHAIN_LOG_FILE), `${mutate(ls).join('\n')}\n`);
      const reopened = await EiStateStore.open({ dir });
      assert.ok(
        !reopened.ok && reopened.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE && reopened.error.context['outcome'] === 'corrupt',
      );
    });
  }
});

test('CORRUPTION while running: the file changed behind a live store -> writes refused, the store goes non-operational, nothing is eligible', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    await writeFile(join(dir, CHAIN_LOG_FILE), `${await raw(dir)}tail-garbage`);
    const r = await a.store.release(trust, 'op_2', [ev(2)]);
    assert.ok(!r.ok && r.error.context['outcome'] === 'corrupt');
    assert.equal(a.store.operational, false);
    assert.equal(a.ledger.isEligible(ev(1).id), false, 'integrity uncertainty makes ALL evidence ineligible');
    await a.store.close();
  });
});

// ───────────────────────────── recovery ─────────────────────────────

test('HEADER-ONLY torn journal: recovered as fresh ONLY under the creation marker; without it the journal needs an operator', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const crashed = await EiStateStore.open({ dir, ops: faultOps(() => true, 'half') });
    assert.ok(!crashed.ok, 'the creation crashed; no store, no acknowledgement');
    assert.equal(await exists(join(dir, CHAIN_INIT_MARKER)), true);
    const b = await boot(dir);
    assert.ok(b.started.ok && b.started.value.events === 0, 'recovered fresh: nothing was lost because nothing had been acknowledged');
    assert.ok((await b.store.release(trust, 'op_1', [ev(1)])).ok);
    await b.store.close();

    const dir2 = join(base, 'state2');
    await EiStateStore.open({ dir: dir2, ops: faultOps(() => true, 'half') });
    await unlink(join(dir2, CHAIN_INIT_MARKER));
    const noMarker = await EiStateStore.open({ dir: dir2 });
    assert.ok(!noMarker.ok && noMarker.error.context['outcome'] === 'corrupt', 'no marker: operator intervention');
  });
});

test('TORN TAIL: a half-written final record is cut and recorded; acknowledged records are untouched; the retry is written once', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir, { ops: faultOps(recIs('release'), 'half') });
    const lost = await a.store.release(trust, 'op_t', [ev(5)]);
    assert.ok(!lost.ok);
    await a.store.close();
    const b = await boot(dir);
    assert.ok(b.started.ok);
    assert.equal(b.store.diagnostics().recoveries, 1);
    assert.equal(b.ledger.stateOf(ev(5).id), undefined);
    assert.ok((await b.store.release(trust, 'op_t', [ev(5)])).ok);
    await b.store.close();
  });
});

test('SINGLE WRITER: a second store on the same directory fails closed (locked); stale-lock takeover is the C0.3 mechanism', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    const second = await EiStateStore.open({ dir });
    assert.ok(!second.ok && second.error.context['outcome'] === 'locked');
    await a.store.close();
  });
});

// ───────────────────────────── authorization, diagnostics, cross-check ─────────────────────────────

test('GRANTS: start() consumes a single-use read grant; a reused or wrong-action grant cannot start the store', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const seedStore = await boot(dir);
    await seedStore.store.close();
    const opened = await EiStateStore.open({ dir });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const grant = await readGrant();
    const args = { trust, inventory: new EnvironmentInventory(), ledger: new EvidenceLedger() };
    assert.ok((await opened.value.start({ grant, ...args })).ok);
    await opened.value.close();
    const again = await EiStateStore.open({ dir });
    assert.ok(again.ok);
    if (!again.ok) return;
    const reuse = await again.value.start({ grant, ...args });
    assert.ok(!reuse.ok, 'the grant was consumed');
    await again.value.close();
  });
});

test('DIAGNOSTICS are content-free: counts, head hash, status and ids of unresolved intents only', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'purge', operationId: 'op_p', sourceId: SourceId(SRC) })).ok);
    const d = a.store.diagnostics();
    const text = JSON.stringify(d);
    assert.equal(d.status, 'operational');
    assert.deepEqual(d.openIntents, ['op_p']);
    assert.ok(/^[0-9a-f]{64}$/.test(d.headHash));
    for (const needle of ['/home', 'secret', 'Quarterly', 'ev_', SRC, 'Bearer', 'message'])
      assert.ok(!text.includes(needle), `diagnostics must not contain ${needle}`);
    await a.store.close();
    assert.equal(a.store.diagnostics().status, 'closed');
  });
});

test('CROSS-CHECK: journal vs audit disagreements are reported as findings (diagnostics, never authority)', async () => {
  await withSandbox(async ({ base }) => {
    const auditDir = join(base, 'audit');
    const stateDir = join(base, 'state');
    const audit = await openEiAuditStore({ dir: auditDir });
    assert.ok(audit.ok);
    if (!audit.ok) return;
    const rec = (op: string, phase: 'attempt' | 'terminal', outcome: 'attempted' | 'completed' | 'revoked', ids?: string[]) => ({
      idempotencyKey: `${op}:${phase}`,
      operationId: op,
      phase,
      outcome,
      operation: outcome === 'revoked' ? ('revoke_evidence' as const) : ('acquire_content' as const),
      occurredAt: T,
      principal: { kind: 'human' as const, id: 'operator-1' },
      connectorId: 'xo.local-filesystem',
      permission: 'filesystem.read',
      ...(ids !== undefined ? { counts: { evidence: ids.length }, evidenceIds: ids } : {}),
    });
    const { CanonicalAuditRecorder } = await import('../src/index.js');
    const recorder = new CanonicalAuditRecorder(audit.value);
    for (const r of [
      rec('op_ok', 'attempt', 'attempted'),
      rec('op_ok', 'terminal', 'completed', [ev(1).id]),
      rec('op_lost', 'attempt', 'attempted'),
      rec('op_lost', 'terminal', 'completed', [ev(2).id]),
    ])
      assert.ok((await recorder.record(r as never, trust)).ok);
    await audit.value.close();

    const a = await boot(stateDir);
    assert.ok((await a.store.release(trust, 'op_ok', [ev(1)])).ok); //          matches audit
    assert.ok((await a.store.release(trust, 'op_nowhere', [ev(3)])).ok); //     journal release with NO audit terminal
    await a.store.close();
    const b = await boot(stateDir);
    assert.ok(b.started.ok);

    const grant = await readGrant();
    const events = await readClosedChainedLog(auditDir, grant, { extensionSchemas: { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA } });
    assert.ok(events.ok);
    const findings = crossCheckState(
      b.started.ok ? b.started.value.operations : [],
      events.ok ? (events.value as readonly AuditEvent[]) : [],
    );
    const kinds = findings.map((f) => `${f.kind}:${f.operationId}`).sort();
    assert.deepEqual(kinds, ['audited_not_released:op_lost', 'released_without_audit:op_nowhere']);
    await b.store.close();
  });
});

// ───────────────────────────── end to end through the EI operations ─────────────────────────────

const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const request = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });
const acquireReq = (sourceId: SourceId, root: string) => ({
  sourceId,
  kind: 'document_content' as const,
  resourceKeys: ['a.txt'],
  scope: scopeOf(root),
});
function freshDeps(): DiscoveryDeps {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  return { registry, inventory: new EnvironmentInventory() };
}
const e2eCtx = (base: string, audit: InMemoryAuditRecorder, ledger: EvidenceLedger, state?: EiStateStore): ConnectorContext => ({
  ...ctxFor(allowRoot(base, ['filesystem.list', 'filesystem.read'])),
  audit,
  ledger,
  ...(state !== undefined ? { state } : {}),
  auditOptions: { acceptTimeoutMs: 2000, attempts: 1 },
});

test('E2E: discover + acquire with a durable store — evidence is released only after the journal write; state and inventory survive restart; the journal has no path or content', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042 confidential');
    const dir = join(base, 'state');
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const store = await EiStateStore.open({ dir });
    assert.ok(store.ok);
    if (!store.ok) return;
    assert.ok(
      (await store.value.start({ grant: await readGrant(), trust: { principal: TEST_PRINCIPAL }, inventory: deps.inventory, ledger })).ok,
    );
    const audit = new InMemoryAuditRecorder();
    const ctx = e2eCtx(base, audit, ledger, store.value);
    const run = await discoverSource(deps, request(root), ctx);
    assert.ok(run.ok && run.value.outcome !== undefined);
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    const got = await acquireSourceContent(deps, acquireReq(sourceId, root), ctx);
    assert.ok(got.ok && got.value.evidence.length > 0);
    const evidenceIds = got.ok ? got.value.evidence.map((e) => e.id) : [];
    assert.ok(evidenceIds.every((id) => ledger.isEligible(id)));
    await store.value.close();

    const text = await raw(dir);
    for (const needle of [root, base, 'a.txt', 'INV-1042', 'approved']) assert.ok(!text.includes(needle), `journal excludes ${needle}`);
    const deps2 = freshDeps();
    const ledger2 = new EvidenceLedger();
    const again = await EiStateStore.open({ dir });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.ok(
      (
        await again.value.start({
          grant: await readGrant(),
          trust: { principal: TEST_PRINCIPAL },
          inventory: deps2.inventory,
          ledger: ledger2,
        })
      ).ok,
    );
    assert.ok(
      evidenceIds.every((id) => ledger2.isEligible(id)),
      'released evidence is still eligible after restart',
    );
    assert.equal(deps2.inventory.get(sourceId)?.axes.acquisition, 'succeeded');
    await again.value.close();
  });
});

test('E2E: if the journal cannot persist a release, the evidence is WITHHELD, nothing is eligible, the store is non-operational, later operations are refused before any attempt, and the audit chain still says what happened', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const store = await EiStateStore.open({ dir: join(base, 'state'), ops: faultOps(recIs('release'), 'failWrite') });
    assert.ok(store.ok);
    if (!store.ok) return;
    assert.ok(
      (await store.value.start({ grant: await readGrant(), trust: { principal: TEST_PRINCIPAL }, inventory: deps.inventory, ledger })).ok,
    );
    const audit = new InMemoryAuditRecorder();
    const ctx = e2eCtx(base, audit, ledger, store.value);
    // discovery itself releases evidence, so the first journaled release is the one that fails.
    const run = await discoverSource(deps, request(root), ctx);
    assert.ok(
      (!run.ok && run.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE) ||
        (run.ok && run.value.stoppedBecause?.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED),
      'the run is refused or reports the withheld evidence',
    );
    assert.equal(ledger.counts().released, 0, 'nothing was released');
    assert.equal(store.value.operational, false, 'unavailable storage fails closed');
    assert.ok(
      audit.events().some((e) => e.outcome === 'completed' && e.operation === 'discover'),
      'the audit chain recorded the completion (authority for what happened)',
    );
    const sourceId = deps.inventory.list()[0]?.source.sourceId as SourceId;
    const before = audit.events().length;
    const refused = await acquireSourceContent(deps, acquireReq(sourceId, root), ctx);
    assert.ok(!refused.ok && refused.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(audit.events().length, before, 'refused BEFORE any audit attempt');
    await store.value.close();
  });
});

test('E2E: a non-operational store REFUSES protected operations before any read or audit attempt (no memory-only fallback)', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const store = await EiStateStore.open({ dir: join(base, 'state') });
    assert.ok(store.ok);
    if (!store.ok) return;
    const audit = new InMemoryAuditRecorder();
    const ctx = e2eCtx(base, audit, ledger, store.value); // never started
    const run = await discoverSource(deps, request(root), ctx);
    assert.ok(!run.ok && run.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(audit.events().length, 0, 'no audit attempt, no read');
    assert.equal(deps.inventory.list().length, 0, 'no inventory change');
    await store.value.close();
  });
});

test('E2E revoke/purge through the EI operations: durable across restart; an audit failure after the journal write keeps the state revoked and a same-operationId retry completes', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const dir = join(base, 'state');
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const store = await EiStateStore.open({ dir });
    assert.ok(store.ok);
    if (!store.ok) return;
    const principal = { principal: TEST_PRINCIPAL };
    assert.ok((await store.value.start({ grant: await readGrant(), trust: principal, inventory: deps.inventory, ledger })).ok);
    const audit = new InMemoryAuditRecorder();
    const ctx = e2eCtx(base, audit, ledger, store.value);
    const run = await discoverSource(deps, request(root), ctx);
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    const got = await acquireSourceContent(deps, acquireReq(sourceId, root), ctx);
    assert.ok(got.ok);

    const rules: PolicyRule[] = ['data.write', 'data.delete'].map((p) => ({
      id: `allow-${p}`,
      effect: 'ALLOW',
      match: { permission: PermissionId(p), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
    }));
    const clock = new MockClock();
    const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: new InMemoryAuditSink(), clock });
    const lifecycle: ConnectorContext = {
      clock,
      authorization: new PermissionManagerAuthorization(manager),
      principal: TEST_PRINCIPAL,
      audit: {
        record: async (e, t) =>
          e.phase === 'terminal'
            ? { ok: false as const, error: { code: 'UNAVAILABLE', message: 'x', retryable: true, context: {} } as never }
            : audit.record(e, t),
      },
      ledger,
      state: store.value,
      auditOptions: { acceptTimeoutMs: 1000, attempts: 1 },
    };
    const first = await revokeSourceEvidence({ inventory: deps.inventory, ledger }, { sourceId, operationId: 'op_revoke_1' }, lifecycle);
    assert.ok(!first.ok && first.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE, 'the completion audit failed');
    assert.ok(
      (got.ok ? got.value.evidence : []).every((e) => ledger.stateOf(e.id) === 'revoked'),
      'but the revoke IS applied',
    );
    await store.value.close();

    const deps2 = freshDeps();
    const ledger2 = new EvidenceLedger();
    const again = await EiStateStore.open({ dir });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.ok((await again.value.start({ grant: await readGrant(), trust: principal, inventory: deps2.inventory, ledger: ledger2 })).ok);
    assert.ok(
      (got.ok ? got.value.evidence : []).every((e) => ledger2.stateOf(e.id) === 'revoked'),
      'still revoked after restart',
    );
    const lifecycle2: ConnectorContext = { ...lifecycle, ledger: ledger2, state: again.value, audit };
    const retried = await revokeSourceEvidence(
      { inventory: deps2.inventory, ledger: ledger2 },
      { sourceId, operationId: 'op_revoke_1' },
      lifecycle2,
    );
    assert.ok(retried.ok, 'the retry with the same operationId completes');
    const purged = await purgeSourceEvidence(
      { inventory: deps2.inventory, ledger: ledger2 },
      { sourceId, targets: [{ purge: async () => undefined }] },
      lifecycle2,
    );
    assert.ok(purged.ok && purged.value.outcome === 'purged');
    await again.value.close();
    const last = await boot(dir);
    assert.ok((got.ok ? got.value.evidence : []).every((e) => last.ledger.stateOf(e.id) === 'purged'));
    await last.store.close();
  });
});

test('COMPAT: with no durable store configured the ledger and inventory behave exactly as before (no gate, no persistence)', () => {
  const ledger = new EvidenceLedger();
  ledger.release('op_1', [ev(1)]);
  assert.equal(ledger.isEligible(ev(1).id), true);
  const inventory = new EnvironmentInventory();
  inventory.observe(source(), T);
  assert.equal(inventory.list().length, 1);
});

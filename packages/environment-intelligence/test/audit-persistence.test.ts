/**
 * C0.3 - EI audit persistence on the CANONICAL audit path (`FileAuditLog` shim -> `CanonicalAuditRecorder` ->
 * `@xo/audit` `ChainedAuditStore`). Chain, tamper, key-mode, torn-tail, fsync and lock-format invariants are proven once,
 * at the canonical layer, in `packages/audit/test/chained-store.test.ts`; this file proves what is specific to EI:
 * restart durability of EI events, the closed EI extension, principal binding, the read boundary, retention alignment,
 * and that EI's fail-closed lifecycle holds on the real durable backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { defaultFileOps, readClosedChainedLog, type FileOps } from '@xo/audit';
import {
  AUDIT_LOCK_FILE,
  AUDIT_LOG_FILE,
  AuditErrorCode,
  ConnectorRegistry,
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EI_AUDIT_EXTENSION_SCHEMA,
  EI_AUDIT_NAMESPACE,
  EnvironmentInventory,
  EvidenceLedger,
  FileAuditLog,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  acquireSourceContent,
  assertRetentionAligned,
  discoverSource,
  purgeSourceEvidence,
  revokeSourceEvidence,
  verifyAuditLog,
  type AuditRecordRequest,
  type AuditTrust,
  type ConnectorContext,
  type DiscoveryDeps,
  type FileAuditLogOptions,
  type FilesystemScope,
  type SourceId,
} from '../src/index.js';
import * as pkg from '../src/index.js';
import { TEST_PRINCIPAL, allowRoot, authenticated, ctxFor, put, withSandbox } from './helpers.js';

const KEY = new Uint8Array(32).fill(7);
const OPERATOR = authenticated('operator-1');
const trust: AuditTrust = { principal: OPERATOR };

const attempt = (op: string, over: Partial<AuditRecordRequest> = {}): AuditRecordRequest => ({
  idempotencyKey: `${op}:attempt`,
  operationId: op,
  phase: 'attempt',
  outcome: 'attempted',
  operation: 'acquire_content',
  occurredAt: '2026-10-12T00:00:00.000Z',
  principal: { kind: 'human', id: 'operator-1' },
  connectorId: 'xo.local-filesystem',
  permission: 'filesystem.read',
  ...over,
});
const terminal = (op: string, outcome: 'completed' | 'failed' = 'completed'): AuditRecordRequest =>
  attempt(op, { idempotencyKey: `${op}:terminal`, phase: 'terminal', outcome });

async function openLog(dir: string, over: Partial<FileAuditLogOptions> = {}): Promise<FileAuditLog> {
  const r = await FileAuditLog.open({ dir, ...over });
  assert.ok(r.ok, `open must succeed (${r.ok ? '' : r.error.code})`);
  return r.value;
}
const rec = (log: FileAuditLog, e: AuditRecordRequest) => log.record(e, trust);
const logPath = (dir: string): string => join(dir, AUDIT_LOG_FILE);
const dirOf = (base: string): string => join(base, 'audit');
const extSchemas = { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA };

/** Operator-local read of a CLOSED log (refuses a live one), viewed as EI request fields. */
async function persisted(dir: string, integrityKey?: Uint8Array) {
  const r = await readClosedChainedLog(dir, { extensionSchemas: extSchemas, ...(integrityKey !== undefined ? { integrityKey } : {}) });
  assert.ok(r.ok, `closed log must read (${r.ok ? '' : r.error.code})`);
  return (r.ok ? r.value : []).map((e) => ({
    event: e,
    ext: (e.extensions?.[EI_AUDIT_NAMESPACE] ?? {}) as Record<string, unknown> & {
      decision?: { authority?: string };
      grantedScope?: { ref?: string };
      counts?: { evidence?: number };
      evidenceIds?: string[];
    },
  }));
}

/** Fault-injecting FileOps: the write of any line whose text matches `shouldFail` throws before a single byte lands. */
function failingOps(shouldFail: (text: string) => boolean): FileOps {
  const wrap = (h: Awaited<ReturnType<FileOps['openAppend']>>) => ({
    write: async (d: Buffer) => {
      if (shouldFail(d.toString())) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await h.write(d);
    },
    sync: () => h.sync(),
    close: () => h.close(),
  });
  return {
    ...defaultFileOps,
    openAppend: async (p) => wrap(await defaultFileOps.openAppend(p)),
    openNew: async (p) => wrap(await defaultFileOps.openNew(p)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Restart durability, ordering, identity
// ---------------------------------------------------------------------------------------------------------------------

test('accepted events survive a restart with identity, order and content intact; sequence continues without reuse', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const clock = new MockClock('2026-10-12T00:00:00.000Z');
    const log = await openLog(dir, { now: () => clock.now() });
    const receipts = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await rec(log, attempt(`op_${i}`));
      assert.ok(r.ok);
      if (r.ok) receipts.push(r.value);
      clock.advance(1000);
    }
    await log.close();
    assert.deepEqual(
      receipts.map((r) => r.sequence),
      [1, 2, 3, 4, 5],
      'strictly increasing, gap-free',
    );
    assert.equal(new Set(receipts.map((r) => r.eventId)).size, 5, 'unique event ids');

    const reopened = await openLog(dir, { now: () => clock.now() });
    const next = await rec(reopened, attempt('op_5'));
    assert.ok(next.ok && next.value.sequence === 6, 'sequence continues after restart, no reuse');
    await reopened.close();
    const events = await persisted(dir);
    assert.deepEqual(
      events.map((e) => e.event.eventId).slice(0, 5),
      receipts.map((r) => r.eventId),
    );
    assert.deepEqual(
      events.map((e) => e.event.correlationId),
      ['op_0', 'op_1', 'op_2', 'op_3', 'op_4', 'op_5'],
    );
    const times = events.map((e) => e.event.recordedAt);
    assert.deepEqual(times, [...times].sort(), 'timestamps are ordered');
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.events === 6);
  });
});

test('events persist their principal, decision, scope and outcome context (and only that)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    const full = attempt('op_ctx', {
      connectorVersion: '1.2.3',
      sourceId: 'src_abc123',
      requestedScope: { kind: 'path', ref: 'scp_aaaaaaaa' },
      grantedScope: { kind: 'path', ref: 'scp_bbbbbbbb' },
      decision: { effect: 'allow', authority: 'platform', policyId: 'allow-1', lifetime: 'session' },
      keysDigest: `sha256:${'a'.repeat(64)}`,
    });
    assert.ok((await rec(log, full)).ok);
    const done = {
      ...terminal('op_ctx', 'completed'),
      counts: { evidence: 3, skipped: 1, errors: 0 },
      evidenceIds: ['ev_1', 'ev_2', 'ev_3'],
      partial: false,
    };
    assert.ok((await rec(log, done)).ok);
    await log.close();
    const [a, t] = await persisted(dir);
    assert.equal(a?.event.actor.id, 'operator-1', 'the actor comes from the authenticated principal');
    assert.equal(a?.event.actor.kind, 'human');
    assert.equal(a?.ext.decision?.authority, 'platform');
    assert.equal(a?.ext.grantedScope?.ref, 'scp_bbbbbbbb');
    assert.equal(a?.ext['connectorVersion'], '1.2.3');
    assert.deepEqual([t?.event.outcome, t?.ext.counts?.evidence, t?.ext.evidenceIds?.length], ['completed', 3, 3]);
    assert.deepEqual(Object.keys(a?.ext ?? {}).sort(), [
      'connectorId',
      'connectorVersion',
      'decision',
      'grantedScope',
      'keysDigest',
      'occurredAt',
      'permission',
      'requestedScope',
      'sourceId',
    ]);
  });
});

test('a SIGKILLed writer loses no acknowledged event; the stale lock is taken over and the chain verifies', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/audit-writer-child.ts', import.meta.url)), dir],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const acked: number[] = [];
    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child produced too few acknowledgements')), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('ERR')) reject(new Error(line));
          const m = /^ACK (\d+) (\d+)$/.exec(line);
          if (m !== null) acked.push(Number(m[2]));
        }
        if (acked.length >= 40) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve();
        }
      });
      child.on('error', reject);
    });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.ok(acked.length >= 40);
    const lockLeft = await stat(join(dir, AUDIT_LOCK_FILE)).then(
      () => true,
      () => false,
    );
    assert.ok(lockLeft, 'the killed writer left its lock behind (the realistic crash case)');
    const live = await verifyAuditLog(dir);
    assert.ok(
      live.ok || live.error.code === AuditErrorCode.LOCKED || live.error.code === AuditErrorCode.CORRUPT,
      'a stale lock never makes verification report success for an unverifiable file',
    );

    const reopened = await FileAuditLog.open({ dir });
    assert.ok(reopened.ok, 'a lock held by a provably dead process on this host is taken over');
    if (!reopened.ok) return;
    await reopened.value.close();
    const done = new Set((await persisted(dir)).map((e) => e.event.correlationId));
    for (const i of acked) assert.ok(done.has(`op_child_${i}`), `acknowledged op_child_${i} survived the kill`);
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok, 'the chain verifies after the crash');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Idempotency, concurrency, checkpoint
// ---------------------------------------------------------------------------------------------------------------------

test('duplicates are idempotent (even when the retry carries a later clock reading), contradictions are refused, nothing extra is written', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const a = await openLog(dir);
    const first = await rec(a, attempt('op_9'));
    assert.ok(first.ok && !first.value.duplicate);
    await a.close();
    const b = await openLog(dir);
    const retry = await rec(b, attempt('op_9', { occurredAt: '2026-10-12T00:00:09.000Z' }));
    assert.ok(
      retry.ok &&
        retry.value.duplicate &&
        first.ok &&
        retry.value.eventId === first.value.eventId &&
        retry.value.sequence === first.value.sequence,
    );
    const contradict = await rec(b, attempt('op_9', { permission: 'filesystem.list' }));
    assert.ok(!contradict.ok && contradict.error.code === AuditErrorCode.CONFLICT);
    const orphan = await rec(b, terminal('op_unknown'));
    assert.ok(!orphan.ok && orphan.error.code === AuditErrorCode.ORDER_VIOLATION);
    await b.close();
    assert.equal((await persisted(dir)).length, 1);
  });
});

test('concurrent appends on one instance are serialized: contiguous sequence, one linear chain', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => rec(log, attempt(`op_c${i}`))));
    assert.ok(results.every((r) => r.ok));
    const seqs = results.map((r) => (r.ok ? r.value.sequence : -1)).sort((x, y) => x - y);
    assert.deepEqual(
      seqs,
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
    await log.close();
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.events === 60);
  });
});

test('an external checkpoint from the EI log detects tail truncation that the file alone cannot (documented limit)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir, { integrityKey: KEY });
    for (let i = 0; i < 3; i += 1) assert.ok((await rec(log, attempt(`op_${i}`))).ok);
    const checkpoint = log.checkpoint();
    await log.close();
    assert.ok((await verifyAuditLog(dir, { integrityKey: KEY, expectedHead: checkpoint })).ok);
    const lines = (await readFile(logPath(dir), 'utf8')).split('\n').filter(Boolean);
    await writeFile(logPath(dir), `${lines.slice(0, -1).join('\n')}\n`);
    assert.ok((await verifyAuditLog(dir, { integrityKey: KEY })).ok, 'LIMIT: the shortened file still verifies on its own');
    const anchored = await verifyAuditLog(dir, { integrityKey: KEY, expectedHead: checkpoint });
    assert.ok(!anchored.ok && anchored.error.code === AuditErrorCode.CORRUPT, 'an externally stored checkpoint detects it');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Trust, read boundary, single history
// ---------------------------------------------------------------------------------------------------------------------

test('principal trust: the audit actor comes only from the authenticated principal; a mismatching or unauthenticated context records nothing', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    // Snapshot says operator-1, trusted context says someone else.
    const other = await log.record(attempt('op_a'), { principal: authenticated('someone-else') });
    assert.ok(!other.ok && other.error.code === AuditErrorCode.INVALID_EVENT);
    // A structural copy / JSON round-trip of a principal is not authenticated.
    const forged = await log.record(attempt('op_b'), { principal: { kind: 'human', id: 'operator-1' } } as unknown as AuditTrust);
    assert.ok(!forged.ok && forged.error.code === AuditErrorCode.INVALID_EVENT);
    const missing = await log.record(attempt('op_c'), undefined as unknown as AuditTrust);
    assert.ok(!missing.ok && missing.error.code === AuditErrorCode.INVALID_EVENT);
    // Same id but different org: still not the same principal.
    const orgSwap = await log.record(attempt('op_d', { principal: { kind: 'human', id: 'operator-1', orgId: 'org-x' } }), trust);
    assert.ok(!orgSwap.ok && orgSwap.error.code === AuditErrorCode.INVALID_EVENT);
    assert.ok((await rec(log, attempt('op_ok'))).ok, 'positive control');
    await log.close();
    assert.deepEqual(
      (await persisted(dir)).map((e) => e.event.correlationId),
      ['op_ok'],
      'the refused events left no trace',
    );
  });
});

test('there is no unauthenticated read of a live EI audit log; verification of a closed file refuses a live one', async () => {
  await withSandbox(async ({ base }) => {
    const surface = pkg as unknown as Record<string, unknown>;
    assert.equal(surface['readAuditLog'], undefined, 'the unrestricted reader no longer exists');
    const dir = dirOf(base);
    const log = await openLog(dir);
    assert.ok((await rec(log, attempt('op_1'))).ok);
    const closedVerify = await verifyAuditLog(dir);
    assert.ok(
      !closedVerify.ok && closedVerify.error.code === AuditErrorCode.LOCKED,
      'operator-local verify cannot be pointed at a live store',
    );
    const liveRead = await log.canonical.read({ kind: 'xo.audit.access-grant', action: 'read' });
    assert.ok(!liveRead.ok, 'a forged grant reads nothing');
    const noGrant = await log.canonical.read(undefined);
    assert.ok(!noGrant.ok);
    await log.close();
  });
});

test('exactly one writable history: a pre-C0.3 audit.log is refused, and the log has no deletion surface', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    await log.close();
    await writeFile(join(dir, 'audit.log'), '{}\n');
    const refused = await FileAuditLog.open({ dir });
    assert.ok(!refused.ok && refused.error.code === AuditErrorCode.INVALID_CONFIG, 'a second history can never coexist');
  });
  const surface = Object.getOwnPropertyNames(FileAuditLog.prototype);
  for (const forbidden of ['delete', 'remove', 'truncate', 'compact', 'prune', 'purge', 'clear', 'rewrite', 'update']) {
    assert.ok(!surface.includes(forbidden), `FileAuditLog must not expose ${forbidden}`);
  }
});

test('retention: audit must outlive the evidence it substantiates', async () => {
  const year = 365 * 24 * 3600 * 1000;
  assert.ok(assertRetentionAligned({ mode: 'indefinite' }, 50 * year).ok);
  assert.ok(assertRetentionAligned({ mode: 'minimum', minimumMs: 7 * year }, 7 * year).ok, 'equal is aligned');
  const short = assertRetentionAligned({ mode: 'minimum', minimumMs: year }, 7 * year);
  assert.ok(!short.ok && short.error.code === AuditErrorCode.INVALID_CONFIG);
  assert.ok(!assertRetentionAligned({ mode: 'indefinite' }, Number.NaN).ok);
  await withSandbox(async ({ base }) => {
    const refused = await FileAuditLog.open({
      dir: join(base, 'a'),
      retention: { mode: 'minimum', minimumMs: year },
      evidenceRetentionMs: 7 * year,
    });
    assert.ok(!refused.ok && refused.error.code === AuditErrorCode.INVALID_CONFIG, 'a misaligned configuration cannot start');
    const fine = await FileAuditLog.open({
      dir: join(base, 'b'),
      retention: { mode: 'minimum', minimumMs: 8 * year },
      evidenceRetentionMs: 7 * year,
    });
    assert.ok(fine.ok);
    if (fine.ok) await fine.value.close();
  });
});

test('operational errors are structured and safe; there is no silent fallback', async () => {
  await withSandbox(async ({ base }) => {
    const blocker = join(base, 'a-file');
    await writeFile(blocker, 'x');
    const bad = await FileAuditLog.open({ dir: join(blocker, 'nested') });
    assert.ok(!bad.ok && bad.error.code === AuditErrorCode.INVALID_CONFIG);
    assert.ok(!JSON.stringify(bad).includes(base), 'no path in the error');

    const dir = dirOf(base);
    const log = await openLog(dir);
    const invalid = await rec(log, { ...attempt('op_x'), content: 'INV-1042 password=hunter2' } as unknown as AuditRecordRequest);
    assert.ok(
      !invalid.ok && invalid.error.code === AuditErrorCode.INVALID_EVENT,
      'the durable backend re-validates: content cannot be persisted',
    );
    const secret = await rec(log, attempt('op_y', { sourceId: 'Bearer abcdefghijklmnop0123456789' }));
    assert.ok(!secret.ok, 'a secret-shaped id is refused by the global filter');
    await log.close();
    const closed = await rec(log, attempt('op_late'));
    assert.ok(!closed.ok && closed.error.code === AuditErrorCode.UNAVAILABLE, 'a closed log refuses (never pretends)');
    const text = await readFile(logPath(dir), 'utf8');
    assert.ok(!text.includes('hunter2') && !text.includes('INV-1042') && !text.includes('abcdefghijklmnop'));
    if (process.platform !== 'win32') assert.equal((await stat(logPath(dir))).mode & 0o077, 0, 'owner-only file mode');
    await chmod(dir, 0o700);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// End to end: EI's fail-closed guarantees hold on the durable backend
// ---------------------------------------------------------------------------------------------------------------------

const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const request = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });
const acquireReq = (sourceId: SourceId, root: string, keys: readonly string[] = ['a.txt']) => ({
  sourceId,
  kind: 'document_content' as const,
  resourceKeys: keys,
  scope: scopeOf(root),
});

function freshDeps(): DiscoveryDeps {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  return { registry, inventory: new EnvironmentInventory() };
}

const ctxWith = (base: string, log: FileAuditLog | InMemoryAuditRecorder, ledger = new EvidenceLedger()): ConnectorContext => ({
  ...ctxFor(allowRoot(base, ['filesystem.list', 'filesystem.read'])),
  audit: log,
  ledger,
  auditOptions: { acceptTimeoutMs: 2000, attempts: 1 },
});

test('persistence failure on the attempt never reads; on completion it quarantines; neither falls back to unaudited release', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042 confidential');
    const deps = freshDeps();
    const good = await openLog(dirOf(base));
    const run = await discoverSource(deps, request(root), ctxWith(base, good));
    assert.ok(run.ok && run.value.outcome !== undefined, 'positive control: the durable backend works end to end');
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    await good.close();

    // 1. Attempt cannot be persisted -> the read never happens.
    const d1 = join(base, 'audit-attempt');
    let reads = 0;
    const attemptLog = await openLog(d1, { ops: failingOps((t) => t.includes('"outcome":"attempted"')) });
    const spyRegistry = new ConnectorRegistry();
    spyRegistry.register(
      new LocalFilesystemConnector({
        fsOps: {
          ...(await import('../src/filesystem/fd-walk.js')).NODE_FS_OPS,
          open: (p, f) => {
            reads += 1;
            return (async () => (await import('../src/filesystem/fd-walk.js')).NODE_FS_OPS.open(p, f))();
          },
        },
      }),
    );
    const blockedDeps: DiscoveryDeps = { registry: spyRegistry, inventory: deps.inventory };
    const blocked = await acquireSourceContent(blockedDeps, acquireReq(sourceId, root), ctxWith(base, attemptLog));
    assert.ok(!blocked.ok && blocked.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.equal(reads, 0, 'no protected read happened');
    await attemptLog.close();

    // 2. Completion cannot be persisted -> quarantine, nothing released, the open attempt stays visible for investigation.
    const d2 = join(base, 'audit-completion');
    const completionLog = await openLog(d2, { ops: failingOps((t) => t.includes('"outcome":"completed"')) });
    const l2 = new EvidenceLedger();
    const quarantined = await acquireSourceContent(deps, acquireReq(sourceId, root), ctxWith(base, completionLog, l2));
    assert.ok(!quarantined.ok && quarantined.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED);
    assert.deepEqual([l2.counts().released, l2.counts().quarantined], [0, 1]);
    assert.equal(completionLog.openAttempts().length, 1, 'the attempt without a terminal event is flagged');
    await completionLog.close();
    const reopened = await verifyAuditLog(d2);
    assert.ok(reopened.ok && reopened.value.openAttempts.length === 1, 'and survives a restart');
    assert.ok(!(await readFile(logPath(d2), 'utf8')).includes('INV-1042'));

    // 3. A closed log (persistence unavailable) refuses everything.
    const closedLog = await openLog(join(base, 'audit-closed'));
    await closedLog.close();
    const refused = await acquireSourceContent(deps, acquireReq(sourceId, root), ctxWith(base, closedLog));
    assert.ok(!refused.ok && refused.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  });
});

test('a log altered behind a live writer: size-changing edits stop protected operations; same-size edits are caught on reopen/verify (documented boundary)', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const dir = dirOf(base);
    const log = await openLog(dir);
    const deps = freshDeps();
    const ctx = ctxWith(base, log);
    const first = await discoverSource(deps, request(root), ctx);
    assert.ok(first.ok && first.value.outcome !== undefined, 'positive control');
    const text = await readFile(logPath(dir), 'utf8');

    // (a) A same-length edit leaves the file size unchanged: the live writer does NOT re-verify history on every append
    //     (that would be O(n) per write). It is caught by the next open, read or verify.
    await writeFile(logPath(dir), text.replace('"outcome":"attempted"', '"outcome":"completed"'));
    await log.close();
    const reopened = await FileAuditLog.open({ dir });
    assert.ok(!reopened.ok && reopened.error.code === AuditErrorCode.CORRUPT, 'reopening a tampered log fails closed');
    assert.ok(!(await verifyAuditLog(dir)).ok, 'closed-file verification reports it');

    // (b) Anything that changes the size behind a live writer is refused on the very next protected operation.
    const dir2 = join(base, 'audit-2');
    const log2 = await openLog(dir2);
    const ctx2 = ctxWith(base, log2);
    assert.ok((await discoverSource(deps, request(root), ctx2)).ok, 'positive control');
    await writeFile(join(dir2, AUDIT_LOG_FILE), `${await readFile(join(dir2, AUDIT_LOG_FILE), 'utf8')}tail-garbage`);
    const second = await discoverSource(deps, request(root), ctx2);
    assert.ok(
      second.ok && second.value.stoppedBecause?.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE && second.value.evidence.length === 0,
    );
    await log2.close();
  });
});

test('purge receipts and the full access history persist, verify, and are not erased by a purge', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const dir = dirOf(base);
    const log = await openLog(dir, { integrityKey: KEY });
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const ctx = ctxWith(base, log, ledger);
    const run = await discoverSource(deps, request(root), ctx);
    assert.ok(run.ok && run.value.outcome !== undefined);
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    assert.ok((await acquireSourceContent(deps, acquireReq(sourceId, root), ctx)).ok);

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
      audit: log,
    };
    const revoked = await revokeSourceEvidence({ inventory: deps.inventory, ledger }, { sourceId }, lifecycle);
    assert.ok(revoked.ok);
    const purged = await purgeSourceEvidence(
      { inventory: deps.inventory, ledger },
      { sourceId, targets: [{ purge: async () => undefined }] },
      lifecycle,
    );
    assert.ok(purged.ok && purged.value.outcome === 'purged');
    const checkpoint = log.checkpoint();
    await log.close();

    assert.ok((await verifyAuditLog(dir, { integrityKey: KEY, expectedHead: checkpoint })).ok);
    const read = await persisted(dir, KEY);
    const steps = read.map((e) => `${e.event.action}:${e.event.lifecycle?.phase}:${e.event.outcome}`);
    assert.ok(
      steps.includes('ei.discover:terminal:completed') && steps.includes('ei.acquire-content:terminal:completed'),
      'the access history is still there',
    );
    assert.ok(steps.includes('ei.revoke-evidence:terminal:revoked') && steps.includes('ei.purge-evidence:terminal:purged'));
    const purgeEvent = read.find((e) => e.event.outcome === 'purged');
    assert.ok((purgeEvent?.ext.evidenceIds ?? []).length > 0, 'the purge receipt names the purged evidence by opaque id');
    assert.deepEqual(new Set(read.map((e) => e.event.actor.id)), new Set([TEST_PRINCIPAL.id]));
    const raw = await readFile(logPath(dir), 'utf8');
    for (const needle of [root, base, 'a.txt', 'INV-1042']) assert.ok(!raw.includes(needle), `persisted events exclude ${needle}`);
  });
});

test('the in-memory recorder is not a production default: EI refuses protected operations when none is configured', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const ctx = { ...ctxWith(base, new InMemoryAuditRecorder()) } as { audit?: unknown };
    delete ctx.audit;
    const run = await discoverSource(freshDeps(), request(root), ctx as ConnectorContext);
    assert.ok(run.ok && run.value.stoppedBecause?.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE && run.value.evidence.length === 0);
  });
});

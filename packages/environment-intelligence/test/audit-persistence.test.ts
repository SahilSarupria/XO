/**
 * P1.0 M4 - durable audit persistence.
 *
 * Restart durability is proven two ways: a clean close/reopen, and a real SIGKILL of a writer process mid-stream.
 * Integrity tests include the NEGATIVE cases the design documents (what a hash chain does not catch), so the claims
 * made in the code are exactly the claims tested. Fail-closed behavior is proven through the real EI operations
 * backed by the durable log, not by calling the log in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import {
  AUDIT_LOCK_FILE,
  AUDIT_LOG_FILE,
  AuditErrorCode,
  ConnectorRegistry,
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceLedger,
  FileAuditLog,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  acquireSourceContent,
  assertRetentionAligned,
  canonicalJson,
  discoverSource,
  purgeSourceEvidence,
  readAuditLog,
  revokeSourceEvidence,
  verifyAuditLog,
  type AuditLogIoHooks,
  type AuditRecordRequest,
  type ConnectorContext,
  type DiscoveryDeps,
  type FileAuditLogOptions,
  type FilesystemScope,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL, allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const KEY = new Uint8Array(32).fill(7);
const ZERO = '0'.repeat(64);

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

const logPath = (dir: string): string => join(dir, AUDIT_LOG_FILE);
const readLines = async (dir: string): Promise<string[]> => (await readFile(logPath(dir), 'utf8')).split('\n').filter((l) => l !== '');
const writeLines = (dir: string, lines: readonly string[]): Promise<void> => writeFile(logPath(dir), `${lines.join('\n')}\n`);

/** Recomputes every hash and prevHash, as an attacker with write access (and, optionally, the key) would. */
function rechain(lines: readonly string[], key?: Uint8Array): string[] {
  let prev = ZERO;
  return lines.map((line) => {
    const { hash: _h, ...rest } = JSON.parse(line) as Record<string, unknown>;
    const body = { ...rest, prevHash: prev };
    const text = canonicalJson(body);
    const hash = key === undefined ? createHash('sha256').update(text).digest('hex') : createHmac('sha256', key).update(text).digest('hex');
    prev = hash;
    return JSON.stringify({ ...body, hash });
  });
}

async function seeded(dir: string, n = 4, over: Partial<FileAuditLogOptions> = {}): Promise<void> {
  const log = await openLog(dir, over);
  for (let i = 0; i < n; i += 1) {
    assert.ok((await log.record(attempt(`op_${i}`))).ok);
    assert.ok((await log.record(terminal(`op_${i}`))).ok);
  }
  await log.close();
}

const dirOf = (base: string): string => join(base, 'audit');

// ---------------------------------------------------------------------------------------------------------------------
// Restart durability, ordering, identity
// ---------------------------------------------------------------------------------------------------------------------

test('accepted events survive a restart with identity, order and content intact', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const clock = new MockClock('2026-10-12T00:00:00.000Z');
    const log = await openLog(dir, { now: () => clock.now() });
    const receipts = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await log.record(attempt(`op_${i}`));
      assert.ok(r.ok);
      if (r.ok) receipts.push(r.value);
      clock.advance(1000);
    }
    await log.close();

    assert.deepEqual(
      receipts.map((r) => r.sequence),
      [2, 3, 4, 5, 6],
      'strictly increasing (the header is sequence 1)',
    );
    assert.equal(new Set(receipts.map((r) => r.eventId)).size, 5, 'unique event ids');

    const reopened = await openLog(dir, { now: () => clock.now() });
    const read = await readAuditLog(dir);
    assert.ok(read.ok);
    if (read.ok) {
      assert.deepEqual(
        read.value.map((e) => e.eventId),
        receipts.map((r) => r.eventId),
      );
      assert.deepEqual(
        read.value.map((e) => e.event.operationId),
        ['op_0', 'op_1', 'op_2', 'op_3', 'op_4'],
      );
      const times = read.value.map((e) => e.recordedAt);
      assert.deepEqual(times, [...times].sort(), 'timestamps are ordered');
    }
    const next = await reopened.record(attempt('op_5'));
    assert.ok(next.ok && next.value.sequence === 7, 'sequence continues after restart, no reuse');
    await reopened.close();
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.ok && report.value.events === 6 && report.value.tornTailBytes === 0);
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
    assert.ok((await log.record(full)).ok);
    const done = terminal('op_ctx', 'completed');
    assert.ok(
      (await log.record({ ...done, counts: { evidence: 3, skipped: 1, errors: 0 }, evidenceIds: ['ev_1', 'ev_2', 'ev_3'], partial: false }))
        .ok,
    );
    await log.close();
    const read = await readAuditLog(dir);
    assert.ok(read.ok);
    if (!read.ok) return;
    const [a, t] = read.value.map((e) => e.event);
    assert.equal(a?.principal.id, 'operator-1');
    assert.equal(a?.decision?.authority, 'platform');
    assert.equal(a?.grantedScope?.ref, 'scp_bbbbbbbb');
    assert.equal(a?.connectorVersion, '1.2.3');
    assert.deepEqual([t?.outcome, t?.counts?.evidence, t?.evidenceIds?.length], ['completed', 3, 3]);
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
    // Stdout lines still in flight when the process died were acknowledged too; they are covered by `>=` below.
    const lockLeft = await stat(join(dir, AUDIT_LOCK_FILE)).then(
      () => true,
      () => false,
    );
    assert.ok(lockLeft, 'the killed writer left its lock behind (the realistic crash case)');

    const reopened = await FileAuditLog.open({ dir });
    assert.ok(reopened.ok, 'a lock held by a provably dead process on this host is taken over');
    if (!reopened.ok) return;
    const read = await readAuditLog(dir);
    assert.ok(read.ok);
    const persisted = new Set(read.ok ? read.value.map((e) => e.event.operationId) : []);
    for (const i of acked) assert.ok(persisted.has(`op_child_${i}`), `acknowledged op_child_${i} survived the kill`);
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.ok, 'the chain verifies after the crash');
    await reopened.value.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------------------------------

test('duplicate submissions are idempotent, contradictions are refused, and neither writes anything (also across restarts)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    const first = await log.record(attempt('op_dup'));
    assert.ok(first.ok && !first.value.duplicate);
    await log.close();
    const sizeBefore = (await stat(logPath(dir))).size;

    const again = await openLog(dir);
    const retry = await again.record(attempt('op_dup', { occurredAt: '2026-10-12T05:00:00.000Z' }));
    assert.ok(
      retry.ok &&
        retry.value.duplicate &&
        first.ok &&
        retry.value.eventId === first.value.eventId &&
        retry.value.sequence === first.value.sequence,
    );
    const contradict = await again.record(attempt('op_dup', { permission: 'filesystem.list' }));
    assert.ok(!contradict.ok && contradict.error.code === AuditErrorCode.CONFLICT);
    const orphan = await again.record(terminal('op_never_attempted'));
    assert.ok(!orphan.ok && orphan.error.code === AuditErrorCode.ORDER_VIOLATION, 'the write-ahead rule holds in the durable log too');
    assert.equal((await stat(logPath(dir))).size, sizeBefore, 'no bytes were written by the retry or the refusals');
    assert.ok((await again.record(terminal('op_dup'))).ok);
    const twice = await again.record(terminal('op_dup', 'failed'));
    assert.ok(!twice.ok && twice.error.code === AuditErrorCode.CONFLICT, 'one terminal outcome per operation');
    await again.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Integrity: what is detected
// ---------------------------------------------------------------------------------------------------------------------

test('a valid log verifies; modification, deletion, reordering, corruption and garbage are each detected', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    await seeded(dir);
    const pristine = await readLines(dir);
    const expectFailure = async (name: string, lines: readonly string[], code: string) => {
      await writeLines(dir, lines);
      const r = await verifyAuditLog(dir);
      assert.ok(
        r.ok && !r.value.ok && r.value.failure?.code === code,
        `${name}: expected ${code}, got ${JSON.stringify(r.ok ? r.value.failure : r)}`,
      );
      const read = await readAuditLog(dir);
      assert.ok(!read.ok && read.error.code === AuditErrorCode.CORRUPT, `${name}: investigation read refuses unverified history`);
      const opened = await FileAuditLog.open({ dir });
      assert.ok(!opened.ok && opened.error.code === AuditErrorCode.CORRUPT, `${name}: open refuses to append`);
      assert.equal((await readLines(dir)).length, lines.length, `${name}: nothing was auto-repaired or appended`);
    };
    await writeLines(dir, pristine);
    assert.ok((await verifyAuditLog(dir)).ok, 'positive control');

    const modified = [...pristine];
    modified[3] = (modified[3] ?? '')
      .replace('"outcome":"attempted"', '"outcome":"completed"')
      .replace('"operation":"acquire_content"', '"operation":"discover"');
    await expectFailure('modified record', modified, 'hash_mismatch');
    await expectFailure(
      'deleted middle record',
      pristine.filter((_, i) => i !== 3),
      'sequence_gap',
    );
    await expectFailure('reordered records', [pristine[0], pristine[2], pristine[1], ...pristine.slice(3)] as string[], 'sequence_gap');
    await expectFailure('duplicated record', [...pristine.slice(0, 3), pristine[2] as string, ...pristine.slice(3)], 'sequence_gap');
    await expectFailure(
      'flipped byte',
      pristine.map((l, i) => (i === 2 ? l.replace('"seq":3', '"seq":3x') : l)),
      'malformed',
    );
    await expectFailure('garbage line', [...pristine, 'not json at all'], 'malformed');
    await expectFailure('foreign first record', pristine.slice(1), 'header_missing');
    await expectFailure(
      'modified header',
      [(pristine[0] ?? '').replace('"retention":"indefinite"', '"retention":"minimum_1ms"'), ...pristine.slice(1)],
      'hash_mismatch',
    );
  });
});

test('every record commits to the whole history before it (a middle edit breaks the next link)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    await seeded(dir, 2);
    const lines = await readLines(dir);
    // Re-hash ONLY the edited record so its own hash is internally consistent: the following record still breaks.
    const edited = JSON.parse(lines[2] as string) as Record<string, unknown>;
    (edited['event'] as Record<string, unknown>)['connectorId'] = 'xo.evil';
    const { hash: _h, ...rest } = edited;
    const forged = { ...rest, hash: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
    await writeLines(dir, [lines[0], lines[1], JSON.stringify(forged), ...lines.slice(3)] as string[]);
    const r = await verifyAuditLog(dir);
    assert.ok(r.ok && !r.value.ok && r.value.failure?.code === 'chain_break' && r.value.failure.sequence === 4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Integrity: what is NOT detected (documented limits, asserted so the docs cannot over-claim)
// ---------------------------------------------------------------------------------------------------------------------

test('LIMIT: an unkeyed chain can be recomputed by anyone who can rewrite the file; an HMAC-keyed chain cannot', async () => {
  await withSandbox(async ({ base }) => {
    const plain = join(base, 'plain');
    await seeded(plain, 2);
    const lines = await readLines(plain);
    const tampered = lines.map((l, i) => (i === 2 ? l.replace('"outcome":"attempted"', '"outcome":"attempted","partial":true') : l));
    await writeLines(plain, rechain(tampered));
    const forged = await verifyAuditLog(plain);
    assert.ok(
      forged.ok && forged.value.ok,
      'WITHOUT a key a recomputed chain still verifies: SHA-256 chaining is tamper-EVIDENT only against non-recomputing edits',
    );

    const keyed = join(base, 'keyed');
    await seeded(keyed, 2, { integrityKey: KEY });
    const klines = await readLines(keyed);
    const ktampered = klines.map((l, i) => (i === 2 ? l.replace('"permission":"filesystem.read"', '"permission":"filesystem.list"') : l));
    await writeLines(keyed, rechain(ktampered));
    const noKey = await verifyAuditLog(keyed, { integrityKey: KEY });
    assert.ok(noKey.ok && !noKey.value.ok, 'a SHA-recomputed chain does not verify under the HMAC key');
    await writeLines(keyed, rechain(ktampered, new Uint8Array(32).fill(9)));
    const wrongKey = await verifyAuditLog(keyed, { integrityKey: KEY });
    assert.ok(wrongKey.ok && !wrongKey.value.ok, 'nor one recomputed with a different key');
    await writeLines(keyed, rechain(ktampered, KEY));
    const rightKey = await verifyAuditLog(keyed, { integrityKey: KEY });
    assert.ok(rightKey.ok && rightKey.value.ok, 'LIMIT: whoever holds the key can still forge');
  });
});

test('LIMIT: dropping the newest records at a record boundary is invisible to the file alone, and caught by an external checkpoint', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    for (let i = 0; i < 4; i += 1) assert.ok((await log.record(attempt(`op_${i}`))).ok);
    const checkpoint = log.checkpoint();
    await log.close();
    const lines = await readLines(dir);
    await writeLines(dir, lines.slice(0, -2));
    const alone = await verifyAuditLog(dir);
    assert.ok(alone.ok && alone.value.ok, 'tail truncation verifies on its own: the chain cannot see what is missing after the head');
    const anchored = await verifyAuditLog(dir, { expectedHead: checkpoint });
    assert.ok(
      anchored.ok && !anchored.value.ok && anchored.value.failure?.code === 'head_mismatch',
      'an externally stored checkpoint detects it',
    );
    await writeLines(dir, lines);
    const intact = await verifyAuditLog(dir, { expectedHead: checkpoint });
    assert.ok(intact.ok && intact.value.ok, 'positive control: the intact log matches its checkpoint');
  });
});

test('integrity key configuration is explicit and mismatches are reported as configuration, not tampering', async () => {
  await withSandbox(async ({ base }) => {
    const keyed = join(base, 'keyed');
    await seeded(keyed, 1, { integrityKey: KEY });
    const noKey = await FileAuditLog.open({ dir: keyed });
    assert.ok(!noKey.ok && noKey.error.code === AuditErrorCode.INVALID_CONFIG);
    const wrong = await FileAuditLog.open({ dir: keyed, integrityKey: new Uint8Array(32).fill(1) });
    assert.ok(!wrong.ok && wrong.error.code === AuditErrorCode.CORRUPT, 'a wrong key cannot verify history');
    const report = await verifyAuditLog(keyed);
    assert.ok(report.ok && !report.value.ok && report.value.failure?.code === 'integrity_mode_mismatch');
    const short = await FileAuditLog.open({ dir: join(base, 'short'), integrityKey: new Uint8Array(8) });
    assert.ok(!short.ok && short.error.code === AuditErrorCode.INVALID_CONFIG);
    const plain = join(base, 'plain');
    await seeded(plain, 1);
    const keyedOpen = await FileAuditLog.open({ dir: plain, integrityKey: KEY });
    assert.ok(!keyedOpen.ok && keyedOpen.error.code === AuditErrorCode.INVALID_CONFIG, 'a log is permanently keyed or unkeyed');
    assert.ok((await verifyAuditLog(keyed, { integrityKey: KEY })).ok, 'positive control');
    const ok = await FileAuditLog.open({ dir: keyed, integrityKey: KEY });
    assert.ok(ok.ok);
    if (ok.ok) await ok.value.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Interrupted writes and recovery
// ---------------------------------------------------------------------------------------------------------------------

const shortWrite = (keepBytes: number): AuditLogIoHooks => ({
  write: async (handle, data) => {
    await handle.write(data, 0, keepBytes);
    throw Object.assign(new Error('power loss at /secret/path'), { code: 'EIO' });
  },
});

test('an interrupted write is not acknowledged, poisons the instance, and is recovered (truncated and noted) on reopen', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    let armed = false;
    const hooks: AuditLogIoHooks = {
      write: async (handle, data) => {
        if (!armed) return (await handle.write(data, 0, data.length)).bytesWritten;
        return shortWrite(Math.floor(data.length / 2)).write?.(handle, data) ?? 0;
      },
    };
    const log = await openLog(dir, { ioHooks: hooks });
    const good = await log.record(attempt('op_good'));
    assert.ok(good.ok);
    armed = true;
    const torn = await log.record(attempt('op_torn'));
    assert.ok(!torn.ok && torn.error.code === AuditErrorCode.UNAVAILABLE, 'not accepted');
    assert.ok(!JSON.stringify(torn).includes('/secret/path'), 'the structured error carries an errno, not the message or a path');
    assert.equal(torn.ok ? '' : torn.error.context['errno'], 'EIO');
    armed = false;
    const after = await log.record(attempt('op_after'));
    assert.ok(!after.ok && after.error.code === AuditErrorCode.UNAVAILABLE, 'poisoned: no further appends until reopen verifies the file');
    await log.close();

    const dirty = await verifyAuditLog(dir);
    assert.ok(
      dirty.ok && dirty.value.ok && dirty.value.tornTailBytes > 0,
      'verification reports the torn tail without calling it tampering',
    );
    const strict = await FileAuditLog.open({ dir, recoverTornTail: false });
    assert.ok(!strict.ok && strict.error.code === AuditErrorCode.CORRUPT, 'recovery can be refused');

    const recovered = await openLog(dir);
    assert.ok(recovered.recovery.tornTailBytesDiscarded > 0);
    const retried = await recovered.record(attempt('op_torn'));
    assert.ok(retried.ok && !retried.value.duplicate, 'the unacknowledged event was not persisted, so the retry writes it once');
    await recovered.close();
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.ok && report.value.tornTailBytes === 0);
    const lines = await readLines(dir);
    assert.ok(
      lines.some((l) => l.includes('"kind":"recovery"')),
      'the discard is itself recorded in the chain',
    );
    const read = await readAuditLog(dir);
    assert.deepEqual(read.ok ? read.value.map((e) => e.event.operationId) : [], ['op_good', 'op_torn']);
  });
});

test('fsync failure: not acknowledged and poisoned; if the line did reach disk, a retry returns the ORIGINAL receipt (no second copy)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    let failSync = false;
    const log = await openLog(dir, {
      ioHooks: {
        sync: async (handle) => {
          if (failSync) throw Object.assign(new Error('sync failed'), { code: 'EIO' });
          await handle.sync();
        },
      },
    });
    assert.ok((await log.record(attempt('op_ok'))).ok);
    failSync = true;
    const unconfirmed = await log.record(attempt('op_unconfirmed'));
    assert.ok(!unconfirmed.ok && unconfirmed.error.code === AuditErrorCode.UNAVAILABLE, 'an unconfirmed write is not accepted');
    await log.close();

    const reopened = await openLog(dir);
    const retry = await reopened.record(attempt('op_unconfirmed'));
    assert.ok(retry.ok && retry.value.duplicate, 'the complete line survived; the retry is recognised, not duplicated');
    await reopened.close();
    const read = await readAuditLog(dir);
    assert.deepEqual(read.ok ? read.value.map((e) => e.event.operationId) : [], ['op_ok', 'op_unconfirmed']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Concurrency and locking
// ---------------------------------------------------------------------------------------------------------------------

test('concurrent appends on one instance are serialized: contiguous sequence, one linear chain', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const log = await openLog(dir);
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => log.record(attempt(`op_c${i}`))));
    assert.ok(results.every((r) => r.ok));
    const seqs = results.map((r) => (r.ok ? r.value.sequence : -1)).sort((a, b) => a - b);
    assert.deepEqual(
      seqs,
      Array.from({ length: 60 }, (_, i) => i + 2),
    );
    await log.close();
    const report = await verifyAuditLog(dir);
    assert.ok(report.ok && report.value.ok && report.value.events === 60);
  });
});

test('exactly one writer owns the log: a live holder, another host, and a closed-then-reopened log', async () => {
  await withSandbox(async ({ base }) => {
    const dir = dirOf(base);
    const first = await openLog(dir);
    const second = await FileAuditLog.open({ dir });
    assert.ok(!second.ok && second.error.code === AuditErrorCode.LOCKED, 'a second writer is refused, not interleaved');
    await first.close();
    await first.close(); // idempotent
    const reopened = await openLog(dir);
    await reopened.close();

    await writeFile(join(dir, AUDIT_LOCK_FILE), `${process.pid + 7_000_000}\nsome-other-host\n`);
    const foreign = await FileAuditLog.open({ dir });
    assert.ok(!foreign.ok && foreign.error.code === AuditErrorCode.LOCKED, 'a lock from another host is never stolen');
    await writeFile(join(dir, AUDIT_LOCK_FILE), 'garbage');
    const unreadable = await FileAuditLog.open({ dir });
    assert.ok(!unreadable.ok && unreadable.error.code === AuditErrorCode.LOCKED, 'an unreadable lock is not stolen either (fail closed)');
    await writeFile(join(dir, AUDIT_LOCK_FILE), `${2 ** 22 + 12345}\n${hostname()}\n`);
    const stale = await FileAuditLog.open({ dir });
    assert.ok(stale.ok, 'a dead pid on this host is taken over');
    if (stale.ok) await stale.value.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Retention, data minimization, operational errors
// ---------------------------------------------------------------------------------------------------------------------

test('retention: audit must outlive the evidence it substantiates; the log has no deletion or compaction surface', async () => {
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
  const surface = Object.getOwnPropertyNames(FileAuditLog.prototype);
  for (const forbidden of ['delete', 'remove', 'truncate', 'compact', 'prune', 'purge', 'clear', 'rewrite', 'update']) {
    assert.ok(!surface.includes(forbidden), `FileAuditLog must not expose ${forbidden}`);
  }
});

test('operational errors are structured and safe; there is no silent fallback', async () => {
  await withSandbox(async ({ base }) => {
    const blocker = join(base, 'a-file');
    await writeFile(blocker, 'x');
    const bad = await FileAuditLog.open({ dir: join(blocker, 'nested') });
    assert.ok(!bad.ok && bad.error.code === AuditErrorCode.UNAVAILABLE && bad.error.retryable);
    assert.ok(!JSON.stringify(bad).includes(base), 'no path in the error');
    assert.match(String(bad.ok ? '' : bad.error.context['errno']), /^E[A-Z]+$/);

    const dir = dirOf(base);
    const log = await openLog(dir);
    const invalid = await log.record({ ...attempt('op_x'), content: 'INV-1042 password=hunter2' } as unknown as AuditRecordRequest);
    assert.ok(
      !invalid.ok && invalid.error.code === AuditErrorCode.INVALID_EVENT,
      'the durable backend re-validates: content cannot be persisted',
    );
    await log.close();
    const closed = await log.record(attempt('op_late'));
    assert.ok(!closed.ok && closed.error.code === AuditErrorCode.UNAVAILABLE, 'a closed log refuses (never pretends)');
    const text = await readFile(logPath(dir), 'utf8');
    assert.ok(!text.includes('hunter2') && !text.includes('INV-1042'));
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
    const dir = dirOf(base);
    let failOn: string | undefined;
    const log = await openLog(dir, {
      ioHooks: {
        write: async (handle, data) => {
          if (failOn !== undefined && data.toString().includes(failOn)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return (await handle.write(data, 0, data.length)).bytesWritten;
        },
      },
    });
    const deps = freshDeps();
    const ledger = new EvidenceLedger();
    const ctx = ctxWith(base, log, ledger);
    const run = await discoverSource(deps, request(root), ctx);
    assert.ok(run.ok && run.value.outcome !== undefined, 'positive control: the durable backend works end to end');
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    await log.close();

    // 1. Attempt cannot be persisted -> the read never happens.
    const d1 = join(base, 'audit-attempt');
    let reads = 0;
    const attemptLog = await openLog(d1, {
      ioHooks: {
        write: async (h, data) => {
          if (data.toString().includes('"outcome":"attempted"')) throw Object.assign(new Error('x'), { code: 'ENOSPC' });
          return (await h.write(data, 0, data.length)).bytesWritten;
        },
      },
    });
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
    const completionLog = await openLog(d2, {
      ioHooks: {
        write: async (h, data) => {
          if (data.toString().includes('"outcome":"completed"')) throw Object.assign(new Error('x'), { code: 'ENOSPC' });
          return (await h.write(data, 0, data.length)).bytesWritten;
        },
      },
    });
    const l2 = new EvidenceLedger();
    const quarantined = await acquireSourceContent(deps, acquireReq(sourceId, root), ctxWith(base, completionLog, l2));
    assert.ok(!quarantined.ok && quarantined.error.code === DiscoveryErrorCode.EVIDENCE_QUARANTINED);
    assert.deepEqual([l2.counts().released, l2.counts().quarantined], [0, 1]);
    assert.equal(completionLog.openAttempts().length, 1, 'the attempt without a terminal event is flagged');
    await completionLog.close();
    const reopened = await verifyAuditLog(d2);
    assert.ok(reopened.ok && reopened.value.ok && reopened.value.openAttempts.length === 1, 'and survives a restart');
    assert.ok(!(await readFile(logPath(d2), 'utf8')).includes('INV-1042'));

    // 3. A closed log (persistence unavailable) refuses everything.
    const closedLog = await openLog(join(base, 'audit-closed'));
    await closedLog.close();
    const refused = await acquireSourceContent(deps, acquireReq(sourceId, root), ctxWith(base, closedLog));
    assert.ok(!refused.ok && refused.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE);
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

    const read = await readAuditLog(dir, { integrityKey: KEY, expectedHead: checkpoint });
    assert.ok(read.ok);
    if (!read.ok) return;
    const steps = read.value.map((e) => `${e.event.operation}:${e.event.phase}:${e.event.outcome}`);
    assert.ok(
      steps.includes('discover:terminal:completed') && steps.includes('acquire_content:terminal:completed'),
      'the access history is still there',
    );
    assert.ok(steps.includes('revoke_evidence:terminal:revoked') && steps.includes('purge_evidence:terminal:purged'));
    const purgeEvent = read.value.find((e) => e.event.outcome === 'purged')?.event;
    assert.ok((purgeEvent?.evidenceIds ?? []).length > 0, 'the purge receipt names the purged evidence by opaque id');
    assert.deepEqual(new Set(read.value.map((e) => e.event.principal.id)), new Set([TEST_PRINCIPAL.id]));
    // Data minimization on disk: event lines carry no path, file name or content.
    const eventLines = (await readLines(dir)).filter((l) => l.includes('"kind":"event"')).join('\n');
    for (const needle of [root, base, 'a.txt', 'INV-1042']) assert.ok(!eventLines.includes(needle), `persisted events exclude ${needle}`);
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

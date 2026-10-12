import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  AuditSemantics,
  auditError,
  canonicalJson,
  normalizeAuditRecordRequest,
  type AuditError,
  type AuditReceipt,
  type AuditRecordRequest,
  type AuditRecorder,
} from './audit.js';

/**
 * P1.0 M4 - durable, append-only audit log. One file, one writer, fsync before acknowledgement.
 *
 * FORMAT  `<dir>/audit.log`: JSON Lines, one record per line, each ending in `\n`:
 *   { v, seq, eventId, recordedAt, kind, prevHash, hash, event | data }
 *   kind `header` (seq 1: logId, format, integrity mode, retention), `event` (an accepted `AuditRecordRequest`),
 *   `recovery` (written after a torn tail was discarded). `hash` = SHA-256 (or HMAC-SHA-256 with an integrity key)
 *   of the canonical JSON of every other field, and `prevHash` is the previous record's `hash`, so every record
 *   commits to the entire history before it.
 *
 * DURABILITY  A record is acknowledged only after its complete line was written to the append-only handle AND
 *   `fsync` returned. A failed or short write, or a failed fsync, poisons the instance: it refuses further appends
 *   until reopened (reopen verifies the file and discards an unacknowledged torn tail). Nothing is acknowledged
 *   that was not synced; something synced but not acknowledged (crash between fsync and return) is found on reopen
 *   and a retry with the same idempotency key returns its ORIGINAL receipt instead of writing a second copy.
 *
 * CONCURRENCY  Exactly one writer owns the log (an exclusive lock file holding pid + host). Appends from one
 *   instance are serialized, so `sequence` is strictly +1 and the chain is linear. A second opener fails with
 *   `AUDIT_LOCKED`. A lock left by a dead process on the same host is taken over; a lock whose holder cannot be
 *   shown dead is never stolen (fail closed). Different hosts sharing a network filesystem are NOT supported.
 *
 * RECOVERY  `open` reads and verifies the whole file. Any complete line that fails verification -> `AUDIT_CORRUPT`
 *   and no appends (no auto-repair of tampering). Only an incomplete FINAL line (no trailing newline) is treated as
 *   an interrupted, never-acknowledged write: it is truncated and a `recovery` record notes how many bytes.
 *
 * INTEGRITY - WHAT THIS DOES AND DOES NOT GUARANTEE (this is not tamper-proof storage):
 *   - Detects modification, deletion or reordering of records that are NOT at the tail, and corruption, because the
 *     chain and sequence break.
 *   - WITHOUT an integrity key, an attacker who can rewrite the file can recompute every hash and the log still
 *     verifies. WITH a secret key (HMAC), forging requires the key; whoever holds the key (or the process memory)
 *     can still forge.
 *   - Truncating the log at a record boundary (dropping the newest N records) is NOT detectable from the file alone.
 *     It is detected only against an external checkpoint (`checkpoint()` / `expectedHead`) kept somewhere the
 *     attacker cannot write.
 *   - It does not defend against a compromised host or process, or against the filesystem lying about fsync.
 *
 * RETENTION  The log offers no delete, truncate-by-age or compaction API: audit history is retained indefinitely, so
 *   audit retention is at least as long as any evidence retention it substantiates. `assertRetentionAligned`
 *   enforces the same rule where a finite audit retention is configured by an operator-owned archival process.
 *
 * LIMITS  The whole log is read at startup (bounded by `maxLogBytes`, default 256 MiB) and the idempotency index is
 *   held in memory: segment rotation / checkpointed startup are deferred.
 */

export const AUDIT_LOG_FILE = 'audit.log';
export const AUDIT_LOCK_FILE = 'audit.lock';
const FORMAT = 'xo-audit-log/1';
const ZERO_HASH = '0'.repeat(64);
const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024;

export type AuditRetentionPolicy = { readonly mode: 'indefinite' } | { readonly mode: 'minimum'; readonly minimumMs: number };

/** Audit retention must be at least as long as the retention of the evidence whose access it substantiates. */
export function assertRetentionAligned(audit: AuditRetentionPolicy, evidenceRetentionMs: number): Result<true, AuditError> {
  if (!Number.isFinite(evidenceRetentionMs) || evidenceRetentionMs < 0) {
    return err(auditError(AuditErrorCode.INVALID_CONFIG, 'evidence retention must be a non-negative finite duration'));
  }
  if (audit.mode === 'indefinite' || audit.minimumMs >= evidenceRetentionMs) return ok(true);
  return err(
    auditError(AuditErrorCode.INVALID_CONFIG, 'audit retention is shorter than the retention of the evidence it substantiates', {
      auditRetentionMs: audit.minimumMs,
      evidenceRetentionMs,
    }),
  );
}

type RecordKind = 'header' | 'event' | 'recovery';

interface StoredRecord {
  readonly v: 1;
  readonly seq: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly kind: RecordKind;
  readonly prevHash: string;
  readonly hash: string;
  readonly event?: AuditRecordRequest;
  readonly data?: Readonly<Record<string, string | number>>;
}

export interface AuditLogEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly event: AuditRecordRequest;
}

export type VerificationFailureCode =
  | 'malformed'
  | 'unsupported_version'
  | 'header_missing'
  | 'sequence_gap'
  | 'chain_break'
  | 'hash_mismatch'
  | 'invalid_event'
  | 'head_mismatch'
  | 'integrity_mode_mismatch';

export interface AuditVerificationReport {
  readonly ok: boolean;
  /** Complete, verified records (including header and recovery records). */
  readonly records: number;
  readonly events: number;
  readonly headSequence: number;
  readonly headHash: string;
  /** Bytes of an incomplete final line (an interrupted, never-acknowledged write). Reported, not an integrity failure. */
  readonly tornTailBytes: number;
  /** Operations with an accepted attempt and no terminal event: outcome unknown, worth investigating. */
  readonly openAttempts: readonly string[];
  readonly failure?: { readonly sequence: number; readonly code: VerificationFailureCode };
}

export interface AuditCheckpoint {
  readonly sequence: number;
  readonly hash: string;
}

const sha = (key: Uint8Array | undefined, text: string): string =>
  key === undefined ? createHash('sha256').update(text).digest('hex') : createHmac('sha256', key).update(text).digest('hex');

function hashOf(rec: Omit<StoredRecord, 'hash'>, key: Uint8Array | undefined): string {
  return sha(key, canonicalJson(rec));
}

interface Scan {
  readonly records: StoredRecord[];
  readonly goodBytes: number;
  readonly tornBytes: number;
  readonly failure?: { readonly sequence: number; readonly code: VerificationFailureCode };
  readonly integrity?: 'sha256' | 'hmac-sha256';
  readonly logId?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pure verification of a log's bytes. Shared by `open` (fail closed) and `verifyAuditLog` (report). */
function scan(bytes: Buffer, key: Uint8Array | undefined): Scan {
  const records: StoredRecord[] = [];
  let offset = 0;
  let prevHash = ZERO_HASH;
  let integrity: 'sha256' | 'hmac-sha256' | undefined;
  let logId: string | undefined;
  const fail = (code: VerificationFailureCode, sequence: number): Scan => ({
    records,
    goodBytes: offset,
    tornBytes: 0,
    failure: { sequence, code },
    ...(integrity !== undefined ? { integrity } : {}),
    ...(logId !== undefined ? { logId } : {}),
  });
  while (offset < bytes.length) {
    const nl = bytes.indexOf(0x0a, offset);
    if (nl === -1) {
      return {
        records,
        goodBytes: offset,
        tornBytes: bytes.length - offset,
        ...(integrity !== undefined ? { integrity } : {}),
        ...(logId !== undefined ? { logId } : {}),
      };
    }
    const expectedSeq = records.length + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(offset, nl).toString('utf8'));
    } catch {
      return fail('malformed', expectedSeq);
    }
    if (!isObject(parsed)) return fail('malformed', expectedSeq);
    if (parsed['v'] !== 1) return fail('unsupported_version', expectedSeq);
    const { seq, eventId, recordedAt, kind, prevHash: prev, hash } = parsed;
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      typeof eventId !== 'string' ||
      typeof recordedAt !== 'string' ||
      (kind !== 'header' && kind !== 'event' && kind !== 'recovery') ||
      typeof prev !== 'string' ||
      typeof hash !== 'string'
    ) {
      return fail('malformed', expectedSeq);
    }
    if (expectedSeq === 1 && kind !== 'header') return fail('header_missing', 1);
    if (seq !== expectedSeq) return fail('sequence_gap', expectedSeq);
    if (prev !== prevHash) return fail('chain_break', seq);
    const { hash: _ignored, ...withoutHash } = parsed;
    if (hashOf(withoutHash as unknown as Omit<StoredRecord, 'hash'>, key) !== hash) return fail('hash_mismatch', seq);
    if (kind === 'event') {
      const normalized = normalizeAuditRecordRequest(parsed['event']);
      if (!normalized.ok) return fail('invalid_event', seq);
    }
    if (kind === 'header') {
      const data = parsed['data'];
      if (!isObject(data) || data['format'] !== FORMAT || (data['integrity'] !== 'sha256' && data['integrity'] !== 'hmac-sha256')) {
        return fail('malformed', seq);
      }
      integrity = data['integrity'];
      logId = typeof data['logId'] === 'string' ? data['logId'] : undefined;
    }
    records.push(parsed as unknown as StoredRecord);
    prevHash = hash;
    offset = nl + 1;
  }
  return {
    records,
    goodBytes: offset,
    tornBytes: 0,
    ...(integrity !== undefined ? { integrity } : {}),
    ...(logId !== undefined ? { logId } : {}),
  };
}

/** Integrity mode recorded in the header line, read WITHOUT verifying (so a key mismatch is reported as configuration, not as tampering). */
function peekIntegrityMode(bytes: Buffer): 'sha256' | 'hmac-sha256' | undefined {
  const nl = bytes.indexOf(0x0a);
  if (nl === -1) return undefined;
  try {
    const first: unknown = JSON.parse(bytes.subarray(0, nl).toString('utf8'));
    const data = isObject(first) ? first['data'] : undefined;
    const mode = isObject(data) ? data['integrity'] : undefined;
    return mode === 'sha256' || mode === 'hmac-sha256' ? mode : undefined;
  } catch {
    return undefined;
  }
}

const modeMismatch = (bytes: Buffer, key: Uint8Array | undefined): boolean => {
  const mode = peekIntegrityMode(bytes);
  return mode !== undefined && (mode === 'hmac-sha256') !== (key !== undefined);
};

function semanticsOf(records: readonly StoredRecord[]): AuditSemantics {
  const semantics = new AuditSemantics();
  for (const r of records) {
    if (r.kind !== 'event' || r.event === undefined) continue;
    semantics.commit(r.event, {
      eventId: r.eventId,
      sequence: r.seq,
      recordedAt: r.recordedAt,
      idempotencyKey: r.event.idempotencyKey,
      outcome: r.event.outcome,
      duplicate: false,
    });
  }
  return semantics;
}

function reportOf(s: Scan, expectedHead?: AuditCheckpoint): AuditVerificationReport {
  const head = s.records[s.records.length - 1];
  let failure = s.failure;
  if (failure === undefined && expectedHead !== undefined) {
    const at = s.records[expectedHead.sequence - 1];
    if (at === undefined || at.hash !== expectedHead.hash) failure = { sequence: expectedHead.sequence, code: 'head_mismatch' };
  }
  return {
    ok: failure === undefined,
    records: s.records.length,
    events: s.records.filter((r) => r.kind === 'event').length,
    headSequence: head?.seq ?? 0,
    headHash: head?.hash ?? ZERO_HASH,
    tornTailBytes: s.tornBytes,
    openAttempts: semanticsOf(s.records).openAttempts(),
    ...(failure !== undefined ? { failure } : {}),
  };
}

export interface VerifyOptions {
  /** Required to verify a log written in HMAC mode. */
  readonly integrityKey?: Uint8Array;
  /** An externally stored checkpoint; detects truncation of the newest records and rewriting of history behind it. */
  readonly expectedHead?: AuditCheckpoint;
  readonly maxLogBytes?: number;
}

/** Read-only verification of a log directory. Does not take the writer lock, never modifies anything. */
export async function verifyAuditLog(dir: string, options: VerifyOptions = {}): Promise<Result<AuditVerificationReport, AuditError>> {
  const bytes = await readLogBytes(dir, options.maxLogBytes);
  if (!bytes.ok) return bytes;
  if (modeMismatch(bytes.value, options.integrityKey)) {
    return ok({
      ok: false,
      records: 0,
      events: 0,
      headSequence: 0,
      headHash: ZERO_HASH,
      tornTailBytes: 0,
      openAttempts: [],
      failure: { sequence: 1, code: 'integrity_mode_mismatch' },
    });
  }
  return ok(reportOf(scan(bytes.value, options.integrityKey), options.expectedHead));
}

/** Verified, ordered events for investigation. Fails (returns the verification failure) rather than return unverified history. */
export async function readAuditLog(dir: string, options: VerifyOptions = {}): Promise<Result<readonly AuditLogEntry[], AuditError>> {
  const bytes = await readLogBytes(dir, options.maxLogBytes);
  if (!bytes.ok) return bytes;
  if (modeMismatch(bytes.value, options.integrityKey)) {
    return err(auditError(AuditErrorCode.INVALID_CONFIG, "the integrity key does not match the log's recorded integrity mode"));
  }
  const result = scan(bytes.value, options.integrityKey);
  const report = reportOf(result, options.expectedHead);
  if (!report.ok) {
    return err(
      auditError(AuditErrorCode.CORRUPT, 'the audit log failed verification', {
        code: report.failure?.code ?? 'unknown',
        sequence: report.failure?.sequence ?? 0,
      }),
    );
  }
  return ok(
    result.records.flatMap((r) =>
      r.kind === 'event' && r.event !== undefined
        ? [{ sequence: r.seq, eventId: r.eventId, recordedAt: r.recordedAt, event: r.event }]
        : [],
    ),
  );
}

async function readLogBytes(dir: string, maxLogBytes = DEFAULT_MAX_LOG_BYTES): Promise<Result<Buffer, AuditError>> {
  const path = join(dir, AUDIT_LOG_FILE);
  try {
    const info = await stat(path);
    if (info.size > maxLogBytes) {
      return err(
        auditError(AuditErrorCode.UNAVAILABLE, 'the audit log exceeds the startup scan limit; segment rotation is not implemented', {
          sizeBytes: info.size,
        }),
      );
    }
    return ok(await readFile(path));
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return ok(Buffer.alloc(0));
    return err(ioError('read', e));
  }
}

function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{2,20}$/.test(code) ? code : 'EUNKNOWN';
}

/** Structured and safe: an operation name and an errno code. Never a path, message text or payload. */
function ioError(op: string, e: unknown): AuditError {
  return auditError(AuditErrorCode.UNAVAILABLE, 'the audit log could not complete the operation', { op, errno: errnoOf(e) });
}

/** TEST SEAM for fault injection (short writes, fsync failure). Production code passes nothing. */
export interface AuditLogIoHooks {
  write?(handle: FileHandle, data: Buffer): Promise<number>;
  sync?(handle: FileHandle): Promise<void>;
}

export interface FileAuditLogOptions {
  readonly dir: string;
  /** Secret key (>= 32 bytes) for HMAC-SHA-256 chaining. A log is permanently either keyed or unkeyed. */
  readonly integrityKey?: Uint8Array;
  readonly retention?: AuditRetentionPolicy;
  /** If set, `open` refuses a finite audit retention shorter than this. */
  readonly evidenceRetentionMs?: number;
  /** Discard an incomplete final line (default true). When false, a torn tail makes `open` fail. */
  readonly recoverTornTail?: boolean;
  readonly maxLogBytes?: number;
  readonly now?: () => Date;
  readonly ioHooks?: AuditLogIoHooks;
}

export class FileAuditLog implements AuditRecorder {
  private lastSeq: number;
  private lastHash: string;
  private closed = false;
  private poisoned = false;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private handle: FileHandle,
    private readonly lockPath: string,
    private readonly key: Uint8Array | undefined,
    private readonly semantics: AuditSemantics,
    private readonly now: () => Date,
    private readonly hooks: AuditLogIoHooks,
    readonly logId: string,
    head: { seq: number; hash: string },
    readonly recovery: { readonly tornTailBytesDiscarded: number },
  ) {
    this.lastSeq = head.seq;
    this.lastHash = head.hash;
  }

  static async open(options: FileAuditLogOptions): Promise<Result<FileAuditLog, AuditError>> {
    const retention = options.retention ?? { mode: 'indefinite' as const };
    if (options.evidenceRetentionMs !== undefined) {
      const aligned = assertRetentionAligned(retention, options.evidenceRetentionMs);
      if (!aligned.ok) return aligned;
    }
    if (retention.mode === 'minimum' && !(Number.isFinite(retention.minimumMs) && retention.minimumMs >= 0)) {
      return err(auditError(AuditErrorCode.INVALID_CONFIG, 'retention must be a non-negative finite duration'));
    }
    if (options.integrityKey !== undefined && options.integrityKey.length < 32) {
      return err(auditError(AuditErrorCode.INVALID_CONFIG, 'the integrity key must be at least 32 bytes'));
    }
    const now = options.now ?? (() => new Date());
    const logPath = join(options.dir, AUDIT_LOG_FILE);
    const lockPath = join(options.dir, AUDIT_LOCK_FILE);

    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return err(ioError('mkdir', e));
    }
    const locked = await acquireLock(lockPath);
    if (!locked.ok) return locked;
    const release = async (): Promise<void> => {
      await rm(lockPath, { force: true });
    };

    let handle: FileHandle | undefined;
    try {
      const bytes = await readLogBytes(options.dir, options.maxLogBytes);
      if (!bytes.ok) {
        await release();
        return bytes;
      }
      if (modeMismatch(bytes.value, options.integrityKey)) {
        await release();
        return err(auditError(AuditErrorCode.INVALID_CONFIG, "the integrity key does not match the log's recorded integrity mode"));
      }
      const scanned = scan(bytes.value, options.integrityKey);
      if (scanned.failure !== undefined) {
        await release();
        return err(
          auditError(AuditErrorCode.CORRUPT, 'the audit log failed verification; appends are refused', {
            code: scanned.failure.code,
            sequence: scanned.failure.sequence,
          }),
        );
      }
      if (scanned.tornBytes > 0 && options.recoverTornTail === false) {
        await release();
        return err(
          auditError(AuditErrorCode.CORRUPT, 'the audit log ends with an incomplete record', { tornTailBytes: scanned.tornBytes }),
        );
      }

      const records = [...scanned.records];
      handle = await open(logPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o600);
      const hooks = options.ioHooks ?? {};
      const writeAll = async (rec: Omit<StoredRecord, 'hash'>): Promise<StoredRecord> => {
        const full: StoredRecord = { ...rec, hash: hashOf(rec, options.integrityKey) };
        const line = Buffer.from(`${JSON.stringify(full)}\n`, 'utf8');
        const written = await (hooks.write ?? defaultWrite)(handle as FileHandle, line);
        if (written !== line.length) throw Object.assign(new Error('short write'), { code: 'EIO' });
        await (hooks.sync ?? defaultSync)(handle as FileHandle);
        return full;
      };

      let discarded = 0;
      if (scanned.tornBytes > 0) {
        // Never acknowledged (acknowledgement follows a complete, synced line), so discarding loses nothing accepted.
        await handle.truncate(scanned.goodBytes);
        await handle.sync();
        discarded = scanned.tornBytes;
      }
      const newLogId = scanned.logId ?? randomBytes(8).toString('hex');
      if (records.length === 0) {
        records.push(
          await writeAll({
            v: 1,
            seq: 1,
            eventId: `aud_${newLogId}_000001`,
            recordedAt: now().toISOString(),
            kind: 'header',
            prevHash: ZERO_HASH,
            data: {
              format: FORMAT,
              logId: newLogId,
              integrity: options.integrityKey === undefined ? 'sha256' : 'hmac-sha256',
              retention: retention.mode === 'indefinite' ? 'indefinite' : `minimum_${retention.minimumMs}ms`,
            },
          }),
        );
        await syncDirectory(options.dir);
      }
      if (discarded > 0) {
        const prev = records[records.length - 1] as StoredRecord;
        records.push(
          await writeAll({
            v: 1,
            seq: prev.seq + 1,
            eventId: `aud_${newLogId}_${String(prev.seq + 1).padStart(6, '0')}`,
            recordedAt: now().toISOString(),
            kind: 'recovery',
            prevHash: prev.hash,
            data: { discardedBytes: discarded, previousHead: prev.hash },
          }),
        );
      }
      const head = records[records.length - 1] as StoredRecord;
      return ok(
        new FileAuditLog(
          options.dir,
          handle,
          lockPath,
          options.integrityKey,
          semanticsOf(records),
          now,
          hooks,
          newLogId,
          { seq: head.seq, hash: head.hash },
          { tornTailBytesDiscarded: discarded },
        ),
      );
    } catch (e) {
      await handle?.close().catch(() => undefined);
      await release();
      return err(ioError('open', e));
    }
  }

  async record(event: AuditRecordRequest): Promise<Result<AuditReceipt, AuditError>> {
    const run = this.chain.then(() => this.append(event));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async append(event: AuditRecordRequest): Promise<Result<AuditReceipt, AuditError>> {
    if (this.closed) return err(auditError(AuditErrorCode.UNAVAILABLE, 'the audit log is closed'));
    if (this.poisoned) {
      return err(auditError(AuditErrorCode.UNAVAILABLE, 'a previous write failed; reopen the audit log to verify and recover'));
    }
    const normalized = normalizeAuditRecordRequest(event);
    if (!normalized.ok) return normalized;
    const decision = this.semantics.decide(normalized.value);
    if (decision.kind === 'duplicate') return ok(decision.receipt);
    if (decision.kind === 'rejected') return err(decision.error);

    const seq = this.lastSeq + 1;
    const body: Omit<StoredRecord, 'hash'> = {
      v: 1,
      seq,
      eventId: `aud_${this.logId}_${String(seq).padStart(6, '0')}`,
      recordedAt: this.now().toISOString(),
      kind: 'event',
      prevHash: this.lastHash,
      event: normalized.value,
    };
    const full: StoredRecord = { ...body, hash: hashOf(body, this.key) };
    const line = Buffer.from(`${JSON.stringify(full)}\n`, 'utf8');
    try {
      const written = await (this.hooks.write ?? defaultWrite)(this.handle, line);
      if (written !== line.length) throw Object.assign(new Error('short write'), { code: 'EIO' });
      await (this.hooks.sync ?? defaultSync)(this.handle);
    } catch (e) {
      // Unknown on-disk state (possibly a partial line): refuse everything until reopen verifies and recovers.
      this.poisoned = true;
      return err(ioError('append', e));
    }
    this.lastSeq = seq;
    this.lastHash = full.hash;
    const receipt: AuditReceipt = {
      eventId: full.eventId,
      sequence: seq,
      recordedAt: full.recordedAt,
      idempotencyKey: normalized.value.idempotencyKey,
      outcome: normalized.value.outcome,
      duplicate: false,
    };
    this.semantics.commit(normalized.value, receipt);
    return ok(receipt);
  }

  /** The newest accepted record. Store it OUTSIDE this host to detect truncation later (`verifyAuditLog(..., { expectedHead })`). */
  checkpoint(): AuditCheckpoint {
    return { sequence: this.lastSeq, hash: this.lastHash };
  }

  openAttempts(): readonly string[] {
    return this.semantics.openAttempts();
  }

  /** Waits for in-flight appends, closes the handle and releases the writer lock. Idempotent. */
  async close(): Promise<void> {
    await this.chain;
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
    await rm(this.lockPath, { force: true });
  }
}

const defaultWrite = async (handle: FileHandle, data: Buffer): Promise<number> => (await handle.write(data, 0, data.length)).bytesWritten;
const defaultSync = (handle: FileHandle): Promise<void> => handle.sync();

async function syncDirectory(dir: string): Promise<void> {
  try {
    const d = await open(dir, constants.O_RDONLY);
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file fsync above is still performed.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** Exclusive writer lock. Stale only if the holder is on THIS host and its pid is provably dead; otherwise never stolen. */
async function acquireLock(lockPath: string): Promise<Result<true, AuditError>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fh = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await fh.writeFile(`${process.pid}\n${hostname()}\n`);
      await fh.sync();
      await fh.close();
      return ok(true);
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') return err(ioError('lock', e));
      let holder: { pid: number; host: string } | undefined;
      try {
        const [pid, host] = (await readFile(lockPath, 'utf8')).split('\n');
        if (/^\d+$/.test(pid ?? '') && host !== undefined) holder = { pid: Number(pid), host };
      } catch {
        holder = undefined;
      }
      if (holder !== undefined && holder.host === hostname() && !pidAlive(holder.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      return err(auditError(AuditErrorCode.LOCKED, 'another writer holds the audit log', { sameHost: holder?.host === hostname() }));
    }
  }
  return err(auditError(AuditErrorCode.LOCKED, 'another writer holds the audit log'));
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AuditError, ErrorCode } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { consumeGrant } from './access.js';
import { canonicalJson, digest } from './canonical.js';
import { validateDraft, type AuditEvent, type AuditEventDraft } from './event.js';
import { validateExtensionSchema, type AuditExtensionSchemas } from './extension.js';
import { defaultFileOps, type AppendHandle, type FileOps, type ReadQuery } from './file-store.js';
import { mintReceipt, type DurableReceipt } from './receipt.js';
import { AuditSemantics } from './semantics.js';
import { buildEvent, type AppendResult, type AuditSink } from './sink.js';
import { FILTERS, validateDraftFields } from './validate.js';

/**
 * ChainedAuditStore — the canonical, tamper-EVIDENT audit store (C0.3). One authoritative append-only history:
 * `audit.chain.jsonl` (+ single-writer lock `audit.chain.lock`). It promotes Environment Intelligence's hash chain and
 * lifecycle guarantees into `@xo/audit` so there is no second authoritative history.
 *
 * GUARANTEES (each is covered by a test):
 *  - Every record commits to the whole history before it: `hash = H(canonical(record minus hash))`, `prevHash` links the
 *    chain. H is SHA-256, or HMAC-SHA-256 when an `integrityKey` (>= 32 bytes) is configured. Modification, deletion in the
 *    middle, reordering and insertion are DETECTED on open, on every read and on `verify`.
 *  - Event `seq` is strictly +1; the chain position `n` is strictly +1. A gap is corruption (there is no purge on this store).
 *  - A durable receipt means the record line was written AND fsynced. A failed write/fsync makes the outcome INDETERMINATE:
 *    the instance is poisoned (no further appends) until reopened; reopening verifies the whole file, fsyncs it, and a
 *    retry with the same idempotency key then returns the ORIGINAL event instead of writing a second one.
 *  - Idempotency / conflict / lifecycle rules are the shared `AuditSemantics`.
 *  - Fail closed: any integrity failure refuses further appends AND refuses reads (nothing unverified is returned).
 *  - Reads require an `AuditAccessGrant` (same controller and checks as the platform store).
 *  - No purge, delete or compaction API exists. `retainUntil` is the indefinite sentinel.
 *
 * NOT GUARANTEED (do not claim otherwise):
 *  - It is tamper-EVIDENT, not tamper-PROOF. An attacker who can rewrite the ENTIRE local file can recompute an unkeyed
 *    chain; and if the attacker can also truncate the file they can remove the LAST records and the remaining prefix still
 *    verifies. A keyed (HMAC) chain stops forgery by anyone without the key, but not deletion of the newest records.
 *    Detecting tail truncation requires an externally stored head (`checkpoint()` -> `expectedHead`); this module provides
 *    the comparison but NO independent anchoring.
 *  - Not defended: a compromised process/host, a filesystem that lies about fsync, network filesystems, multiple hosts.
 *  - Single writer per directory (lifetime lock); a second writer fails closed with AUDIT_LOCKED.
 */
export const CHAIN_LOG_FILE = 'audit.chain.jsonl';
export const CHAIN_LOCK_FILE = 'audit.chain.lock';
export const CHAIN_FORMAT = 'xo-audit-chain/1';
export const INDEFINITE_RETENTION = '9999-12-31T23:59:59.999Z';
const GENESIS = '0'.repeat(64);
const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ACTOR_KINDS: ReadonlySet<string> = new Set(['human', 'service', 'system', 'anonymous']);

/**
 * A persisted actor was minted at write time and cannot be re-minted at read time, so its SHAPE is re-checked instead:
 * only kind/id/orgId, a known kind, and path-safe identifiers. Anything else (extra members, odd ids) is corruption.
 */
function isWellFormedStoredActor(a: unknown): boolean {
  if (!isRec(a)) return false;
  for (const k of Object.keys(a)) if (k !== 'kind' && k !== 'id' && k !== 'orgId') return false;
  if (typeof a['kind'] !== 'string' || !ACTOR_KINDS.has(a['kind'])) return false;
  for (const f of ['id', 'orgId'] as const) {
    const v = a[f];
    if (v !== undefined && (typeof v !== 'string' || !STORED_ACTOR_ID_RE.test(v))) return false;
  }
  return true;
}
const MIN_KEY_BYTES = 32;

export interface ChainedAuditStoreOptions {
  readonly dir: string;
  /** Optional HMAC key (>= 32 bytes). The key is never persisted; the header records only the MODE. */
  readonly integrityKey?: Uint8Array;
  /** Registered closed extension schemas (see extension.ts). Drafts with any other namespace are rejected. */
  readonly extensionSchemas?: AuditExtensionSchemas;
  readonly clock?: () => Date;
  readonly ops?: FileOps;
  readonly grantMaxAgeMs?: number;
}

export interface ChainHead {
  readonly records: number;
  readonly events: number;
  readonly hash: string;
}
export interface ChainCheckpoint extends ChainHead {
  readonly logId: string;
}
export interface ChainVerifyReport extends ChainHead {
  readonly logId: string;
  readonly integrity: 'sha256' | 'hmac-sha256';
  readonly openAttempts: readonly string[];
  readonly recoveries: number;
  /** Set when `expectedHead` was supplied and matched. */
  readonly anchoredTo?: ChainCheckpoint;
}
export interface ChainVerifyOptions {
  /** An externally held checkpoint. A mismatch (including a shorter chain = truncation) is `AUDIT_CORRUPT`. */
  readonly expectedHead?: ChainCheckpoint;
}

interface ChainRecord {
  readonly v: 1;
  readonly n: number;
  readonly kind: 'header' | 'event' | 'recovery';
  readonly recordedAt: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly event?: AuditEvent;
}

const corrupt = (why: string): AuditError => new AuditError(ErrorCode.AUDIT_CORRUPT, `audit log failed integrity verification: ${why}`);
const unavailable = (msg: string, cause?: unknown): AuditError =>
  new AuditError(ErrorCode.AUDIT_UNAVAILABLE, msg, cause === undefined ? undefined : { cause });
const config = (msg: string): AuditError => new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, msg);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Scan {
  readonly logId: string;
  readonly integrity: 'sha256' | 'hmac-sha256';
  readonly records: number;
  readonly events: AuditEvent[];
  readonly lastHash: string;
  /** Hash of every record, in order (index i = record n=i). Used to anchor an external checkpoint inside the chain. */
  readonly hashes: readonly string[];
  readonly lastRecordedAt: string;
  readonly recoveries: number;
  /** Byte length of the verified prefix (everything up to and including the last complete, valid line). */
  readonly goodBytes: number;
  /** True when bytes follow the verified prefix that are an unterminated (never-acknowledged) write. */
  readonly tornTail: boolean;
  readonly semantics: AuditSemantics<AuditEvent>;
}

function recordHash(key: Uint8Array | undefined, rec: Omit<ChainRecord, 'hash'>): string {
  return digest(key, canonicalJson(rec));
}

/** Verifies the whole file. Any failure is `AUDIT_CORRUPT`: there is no "skip the bad line and continue". */
function scan(text: string, key: Uint8Array | undefined, schemas: AuditExtensionSchemas): Result<Scan, AuditError> {
  const semantics = new AuditSemantics<AuditEvent>(schemas);
  const events: AuditEvent[] = [];
  let pos = 0;
  let n = -1;
  let prev = GENESIS;
  let logId = '';
  let integrity: 'sha256' | 'hmac-sha256' = 'sha256';
  let lastRecordedAt = '';
  let recoveries = 0;
  let goodBytes = 0;
  const hashes: string[] = [];
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break; // unterminated tail: never acknowledged
    const line = text.slice(pos, nl);
    pos = nl + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return err(corrupt(`record ${n + 1} is not valid JSON`));
    }
    if (!isRec(raw) || raw['v'] !== 1 || typeof raw['hash'] !== 'string' || typeof raw['prevHash'] !== 'string')
      return err(corrupt(`record ${n + 1} is malformed`));
    const { hash, ...rest } = raw as Record<string, unknown> & { hash: string };
    if (rest['n'] !== n + 1) return err(corrupt(`record ${n + 1} is out of sequence (deleted, inserted or reordered)`));
    if (rest['prevHash'] !== prev) return err(corrupt(`record ${n + 1} does not chain to its predecessor`));
    if (n === -1) {
      const data = rest['data'];
      if (rest['kind'] !== 'header' || !isRec(data) || data['format'] !== CHAIN_FORMAT || typeof data['logId'] !== 'string')
        return err(corrupt('the first record is not a recognised header'));
      const mode = data['integrity'];
      if (mode !== 'sha256' && mode !== 'hmac-sha256') return err(corrupt('header integrity mode is unknown'));
      if ((mode === 'hmac-sha256') !== (key !== undefined))
        return err(config('the log integrity mode does not match the configured integrityKey'));
      integrity = mode;
      logId = data['logId'];
    }
    if (hash !== recordHash(key, rest as unknown as Omit<ChainRecord, 'hash'>)) return err(corrupt(`record ${n + 1} hash does not verify`));
    const kind = rest['kind'];
    if (typeof rest['recordedAt'] !== 'string') return err(corrupt(`record ${n + 1} has no time`));
    if (kind === 'event') {
      const ev = rest['event'];
      if (!isRec(ev) || ev['seq'] !== events.length + 1 || ev['recordedAt'] !== rest['recordedAt'])
        return err(corrupt(`record ${n + 1} event sequence/time is inconsistent`));
      const {
        schemaVersion: _sv,
        eventId: _id,
        seq: _seq,
        recordedAt: _t,
        retainUntil: _r,
        classification: _c,
        ...content
      } = ev as Record<string, unknown>;
      // Re-validate through the SAME closed schema used on write: an injected field or a sensitive value is corruption.
      const v = validateDraftFields(content, { actorOk: isWellFormedStoredActor, extensionSchemas: schemas });
      if (
        !v.ok ||
        typeof ev['eventId'] !== 'string' ||
        !EVENT_ID_RE.test(ev['eventId']) ||
        ev['schemaVersion'] !== 1 ||
        ev['classification'] !== 'restricted' ||
        ev['retainUntil'] !== INDEFINITE_RETENTION
      )
        return err(corrupt(`record ${n + 1} event does not satisfy the closed audit schema`));
      const decision = semantics.decide(v.value);
      if (decision.kind !== 'append') return err(corrupt(`record ${n + 1} contradicts earlier history`));
      semantics.commit(v.value, decision.digest, ev as unknown as AuditEvent);
      events.push(ev as unknown as AuditEvent);
    } else if (kind === 'recovery') {
      recoveries++;
    } else if (kind !== 'header') {
      return err(corrupt(`record ${n + 1} has an unknown kind`));
    }
    n++;
    hashes.push(hash);
    prev = hash;
    lastRecordedAt = rest['recordedAt'];
    goodBytes = pos;
  }
  if (n < 0) return err(corrupt('the log has no header'));
  return ok({
    logId,
    integrity,
    records: n + 1,
    events,
    lastHash: prev,
    hashes,
    lastRecordedAt,
    recoveries,
    goodBytes,
    tornTail: goodBytes < text.length,
    semantics,
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when a lock file exists and its owner may still be running (or is on another host and so cannot be judged). */
async function lockIsLive(lockPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const l = JSON.parse(text) as { pid?: unknown; host?: unknown };
    if (typeof l.pid !== 'number' || typeof l.host !== 'string') return true;
    return l.host !== hostname() || pidAlive(l.pid);
  } catch {
    return true;
  }
}

function validateKey(key: Uint8Array | undefined): AuditError | undefined {
  return key !== undefined && key.byteLength < MIN_KEY_BYTES ? config(`integrityKey must be at least ${MIN_KEY_BYTES} bytes`) : undefined;
}

export class ChainedAuditStore implements AuditSink {
  readonly mode = 'durable' as const;
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned: AuditError | undefined;
  private closed = false;

  private constructor(
    private readonly o: ChainedAuditStoreOptions,
    private readonly file: string,
    private readonly lockPath: string,
    private readonly handle: AppendHandle,
    private readonly schemas: AuditExtensionSchemas,
    private readonly key: Uint8Array | undefined,
    private readonly logId: string,
    private readonly semantics: AuditSemantics<AuditEvent>,
    private records: number,
    private events: number,
    private lastHash: string,
    private expectedBytes: number,
    private readonly recoveries: number,
  ) {}

  static async open(options: ChainedAuditStoreOptions): Promise<Result<ChainedAuditStore, AuditError>> {
    const keyErr = validateKey(options.integrityKey);
    if (keyErr !== undefined) return err(keyErr);
    const schemas = options.extensionSchemas ?? {};
    for (const [ns, schema] of Object.entries(schemas)) {
      if (schema.namespace !== ns) return err(config('an extension schema is registered under the wrong namespace'));
      const r = validateExtensionSchema(schema, FILTERS);
      if (!r.ok) return err(config(r.error.message));
    }
    const ops = options.ops ?? defaultFileOps;
    const file = join(options.dir, CHAIN_LOG_FILE);
    const lockPath = join(options.dir, CHAIN_LOCK_FILE);
    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
    } catch {
      return err(config('audit directory could not be prepared'));
    }
    const locked = await ChainedAuditStore.acquireLock(lockPath);
    if (!locked.ok) return locked;
    const release = async (): Promise<void> => {
      await unlink(lockPath).catch(() => undefined);
    };
    try {
      let text = '';
      try {
        text = await readFile(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const clock = options.clock ?? (() => new Date());
      let handle: AppendHandle;
      let sc: Scan;
      if (text.length === 0) {
        // Fresh log: write the header exclusively (or, if a crash left a zero-byte file, append it).
        const logId = randomUUID();
        const rec = ChainedAuditStore.seal(options.integrityKey, {
          v: 1,
          n: 0,
          kind: 'header',
          recordedAt: clock().toISOString(),
          prevHash: GENESIS,
          data: { format: CHAIN_FORMAT, logId, integrity: options.integrityKey === undefined ? 'sha256' : 'hmac-sha256' },
        });
        try {
          handle = await ops.openNew(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          handle = await ops.openAppend(file);
        }
        const line = Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8');
        await handle.write(line);
        await handle.sync();
        await ops.syncDir(options.dir);
        const s = scan(line.toString('utf8'), options.integrityKey, schemas);
        if (!s.ok) throw s.error;
        sc = s.value;
      } else {
        const s = scan(text, options.integrityKey, schemas);
        if (!s.ok) {
          await release();
          return s;
        }
        sc = s.value;
        handle = await ops.openAppend(file);
        if (sc.tornTail) {
          // A write that was never acknowledged (no terminating newline). Cut it back to the verified prefix and RECORD
          // that we did, so recovery is itself part of the chain rather than a silent repair.
          await handle.close();
          await truncate(file, sc.goodBytes);
          handle = await ops.openAppend(file);
          const rec = ChainedAuditStore.seal(options.integrityKey, {
            v: 1,
            n: sc.records,
            kind: 'recovery',
            recordedAt: clock().toISOString(),
            prevHash: sc.lastHash,
            data: { reason: 'torn-tail', truncatedBytes: Buffer.byteLength(text, 'utf8') - sc.goodBytes },
          });
          await handle.write(Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8'));
          const rescanned = scan(await readFile(file, 'utf8'), options.integrityKey, schemas);
          if (!rescanned.ok) throw rescanned.error;
          sc = rescanned.value;
        }
        // Everything read at open is made durable BEFORE any caller can be told a retry is a duplicate of it, so a
        // record that landed during an indeterminate failure is never reported durable while only in page cache.
        await handle.sync();
      }
      const bytes = (await stat(file)).size;
      return ok(
        new ChainedAuditStore(
          options,
          file,
          lockPath,
          handle,
          schemas,
          options.integrityKey,
          sc.logId,
          sc.semantics,
          sc.records,
          sc.events.length,
          sc.lastHash,
          bytes,
          sc.recoveries,
        ),
      );
    } catch (cause) {
      await release();
      return err(cause instanceof AuditError ? cause : unavailable('audit log could not be opened', cause));
    }
  }

  private static seal(key: Uint8Array | undefined, rec: Omit<ChainRecord, 'hash'>): ChainRecord {
    return { ...rec, hash: recordHash(key, rec) };
  }

  /**
   * Single-writer lock. Creation is exclusive (`wx`). Taking over a lock whose owner is provably dead is a
   * check-then-delete, which is a race when several processes find the same stale lock at once (one deletes the fresh lock
   * another just created, leaving two writers). So the takeover is serialized by an exclusive `.takeover` guard and the
   * staleness is RE-CHECKED while holding it. Only guard holders ever delete a lock they did not create; a leftover guard
   * (a crash during takeover) fails CLOSED with AUDIT_LOCKED until an operator removes it.
   */
  private static async acquireLock(lockPath: string): Promise<Result<true, AuditError>> {
    const body = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
    const locked = (): Result<true, AuditError> => err(new AuditError(ErrorCode.AUDIT_LOCKED, 'another writer owns this audit log'));
    const create = async (): Promise<'created' | 'exists' | 'error'> => {
      try {
        await writeFile(lockPath, body, { flag: 'wx', mode: 0o600 });
        return 'created';
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'error';
      }
    };
    const first = await create();
    if (first === 'created') return ok(true);
    if (first === 'error') return err(config('audit lock could not be created'));
    if (await lockIsLive(lockPath)) return locked();

    const guard = `${lockPath}.takeover`;
    try {
      await writeFile(guard, body, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return locked(); // someone else is taking over (or crashed doing so)
      return err(config('audit lock could not be created'));
    }
    try {
      if (await lockIsLive(lockPath)) return locked(); // a faster taker already installed a live lock
      await unlink(lockPath).catch(() => undefined); // provably dead owner on this host
      const second = await create();
      return second === 'created' ? ok(true) : second === 'exists' ? locked() : err(config('audit lock could not be created'));
    } finally {
      await unlink(guard).catch(() => undefined);
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async append(draft: AuditEventDraft): Promise<AppendResult> {
    return this.serialized(() => this.appendLocked(draft));
  }

  private async appendLocked(draft: AuditEventDraft): Promise<AppendResult> {
    if (this.closed) return { ok: false, error: unavailable('audit log is closed'), indeterminate: false };
    if (this.poisoned !== undefined) return { ok: false, error: this.poisoned, indeterminate: false };
    const valid = validateDraft(draft, { extensionSchemas: this.schemas });
    if (!valid.ok) return { ok: false, error: valid.error, indeterminate: false };
    const decision = this.semantics.decide(valid.value);
    if (decision.kind === 'rejected') return { ok: false, error: decision.error, indeterminate: false };
    if (decision.kind === 'duplicate')
      return { ok: true, duplicate: true, event: decision.entry, receipt: this.receiptFor(decision.entry) };
    // The file must be exactly what we last wrote. A size mismatch means someone changed it behind our back: fail closed.
    try {
      if ((await stat(this.file)).size !== this.expectedBytes) return this.poison(corrupt('the log file changed outside this writer'));
    } catch (cause) {
      return this.poison(unavailable('audit log is unavailable', cause), true);
    }
    const now = (this.o.clock ?? (() => new Date()))();
    const recordedAt = now.toISOString();
    const event = buildEvent(valid.value, { eventId: randomUUID(), seq: this.events + 1, recordedAt, retainUntil: INDEFINITE_RETENTION });
    const rec = ChainedAuditStore.seal(this.key, { v: 1, n: this.records, kind: 'event', recordedAt, prevHash: this.lastHash, event });
    const line = Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8');
    try {
      await this.handle.write(line);
      await this.handle.sync();
    } catch (cause) {
      // Bytes may or may not have landed: INDETERMINATE. Stop writing; reopening verifies and reconciles by idempotency key.
      this.poisoned = unavailable('audit log write could not be confirmed durable; reopen to reconcile', cause);
      return { ok: false, error: unavailable('audit write could not be confirmed durable', cause), indeterminate: true };
    }
    this.records++;
    this.events++;
    this.lastHash = rec.hash;
    this.expectedBytes += line.length;
    this.semantics.commit(valid.value, decision.digest, event);
    return { ok: true, duplicate: false, event, receipt: this.receiptFor(event) };
  }

  private poison(error: AuditError, indeterminate = false): AppendResult {
    this.poisoned = error;
    return { ok: false, error, indeterminate };
  }

  private receiptFor(event: AuditEvent): DurableReceipt {
    return mintReceipt({
      eventId: event.eventId,
      seq: event.seq,
      storeId: this.logId,
      recordedAt: event.recordedAt,
      guarantee: 'fsync-file',
    });
  }

  /** Reads and fully verifies the log; any inconsistency with the in-memory head poisons the store (fail closed). */
  private async verifiedScan(): Promise<Result<Scan, AuditError>> {
    if (this.poisoned !== undefined && this.poisoned.code === ErrorCode.AUDIT_CORRUPT) return err(this.poisoned);
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (cause) {
      return err(unavailable('audit log is unavailable', cause));
    }
    const s = scan(text, this.key, this.schemas);
    if (!s.ok) {
      this.poisoned = s.error;
      return s;
    }
    if (s.value.tornTail || s.value.records !== this.records || s.value.lastHash !== this.lastHash) {
      this.poisoned = corrupt('the log on disk does not match the history this writer holds (truncated or replaced)');
      return err(this.poisoned);
    }
    return s;
  }

  /** Authorized, VERIFIED read. Nothing unverified is ever returned. */
  async read(grant: unknown, query: ReadQuery = {}): Promise<Result<{ readonly events: readonly AuditEvent[] }, AuditError>> {
    const g = consumeGrant(grant, 'read', Date.now(), this.o.grantMaxAgeMs ?? 30_000);
    if (!g.ok) return g;
    return this.serialized(async () => {
      const s = await this.verifiedScan();
      if (!s.ok) return s;
      let events = s.value.events;
      if (query.correlationId !== undefined) events = events.filter((e) => e.correlationId === query.correlationId);
      if (query.executionId !== undefined) events = events.filter((e) => e.executionId === query.executionId);
      if (query.afterSeq !== undefined) events = events.filter((e) => e.seq > (query.afterSeq as number));
      if (query.limit !== undefined) events = events.slice(0, query.limit);
      return ok({ events });
    });
  }

  /** Authorized verification of the live log, optionally against an externally held checkpoint. */
  async verify(grant: unknown, options: ChainVerifyOptions = {}): Promise<Result<ChainVerifyReport, AuditError>> {
    const g = consumeGrant(grant, 'read', Date.now(), this.o.grantMaxAgeMs ?? 30_000);
    if (!g.ok) return g;
    return this.serialized(async () => {
      const s = await this.verifiedScan();
      if (!s.ok) return s;
      return reportOf(s.value, options);
    });
  }

  /** The current head: counts and a hash only (no event content). Store it somewhere the log's writer cannot rewrite. */
  checkpoint(): ChainCheckpoint {
    return { logId: this.logId, records: this.records, events: this.events, hash: this.lastHash };
  }

  /** Operation ids with an accepted attempt and no terminal event. In-process, owner-only; ids only, no content. */
  openAttempts(): readonly string[] {
    return this.semantics.openAttempts();
  }

  /** Number of torn-tail recoveries recorded in the chain (informational). */
  get recoveryCount(): number {
    return this.recoveries;
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
    await unlink(this.lockPath).catch(() => undefined);
  }
}

function reportOf(s: Scan, options: ChainVerifyOptions): Result<ChainVerifyReport, AuditError> {
  const exp = options.expectedHead;
  if (exp !== undefined) {
    if (exp.logId !== s.logId) return err(corrupt('the checkpoint belongs to a different log'));
    if (s.records < exp.records) return err(corrupt('the log is SHORTER than the external checkpoint (records were removed)'));
    // The checkpointed head must sit at its recorded position in the current chain. (scan() has already verified every
    // link, so a rewritten prefix would have to reproduce the externally held hash.)
    if (s.hashes[exp.records - 1] !== exp.hash) return err(corrupt('the external checkpoint is not part of this chain'));
  }
  return ok({
    logId: s.logId,
    integrity: s.integrity,
    records: s.records,
    events: s.events.length,
    hash: s.lastHash,
    openAttempts: s.semantics.openAttempts(),
    recoveries: s.recoveries,
    ...(exp !== undefined ? { anchoredTo: exp } : {}),
  });
}

/**
 * OPERATOR-LOCAL, closed-file verification and inspection. These do NOT go through the access controller because they
 * operate on a file that no writer holds; filesystem permissions are the authorization. They REFUSE a live store
 * (lock file present with a running owner) so they cannot be used to bypass live-store authorization.
 */
export interface ClosedLogOptions extends ChainVerifyOptions {
  readonly integrityKey?: Uint8Array;
  readonly extensionSchemas?: AuditExtensionSchemas;
  readonly grantMaxAgeMs?: number;
}
async function scanClosed(dir: string, o: ClosedLogOptions): Promise<Result<Scan, AuditError>> {
  const keyErr = validateKey(o.integrityKey);
  if (keyErr !== undefined) return err(keyErr);
  if (await lockIsLive(join(dir, CHAIN_LOCK_FILE)))
    return err(
      new AuditError(ErrorCode.AUDIT_LOCKED, 'the audit log is held by a live writer; use the authorized verify/read on that store'),
    );
  let text: string;
  try {
    text = await readFile(join(dir, CHAIN_LOG_FILE), 'utf8');
  } catch (cause) {
    return err(unavailable('audit log could not be read', cause));
  }
  const s = scan(text, o.integrityKey, o.extensionSchemas ?? {});
  if (!s.ok) return s;
  if (s.value.tornTail) return err(corrupt('the log ends with an unterminated write (open it once with a writer to record recovery)'));
  return s;
}
export async function verifyClosedChainedLog(dir: string, options: ClosedLogOptions = {}): Promise<Result<ChainVerifyReport, AuditError>> {
  const s = await scanClosed(dir, options);
  return s.ok ? reportOf(s.value, options) : s;
}
/**
 * Reading EVENT CONTENT of a closed log is a read like any other: it requires the same single-use `read` grant as the live
 * store. (`verifyClosedChainedLog` returns counts and a hash only and needs no grant.)
 */
export async function readClosedChainedLog(
  dir: string,
  grant: unknown,
  options: ClosedLogOptions = {},
): Promise<Result<readonly AuditEvent[], AuditError>> {
  const g = consumeGrant(grant, 'read', Date.now(), options.grantMaxAgeMs ?? 30_000);
  if (!g.ok) return g;
  const s = await scanClosed(dir, options);
  return s.ok ? ok(s.value.events) : s;
}

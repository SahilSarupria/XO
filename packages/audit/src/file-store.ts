import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AuditError, ErrorCode } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { consumeGrant } from './access.js';
import { AUDIT_EVENT_TYPES, AUDIT_SCHEMA_VERSION, validateDraft, type AuditEvent, type AuditEventDraft } from './event.js';
import { mintReceipt } from './receipt.js';
import { buildEvent, type AppendResult, type AuditSink } from './sink.js';

/** Minimal file operations, injectable so tests can simulate partial writes, fsync failure and crashes. */
export interface AppendHandle {
  write(data: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface FileOps {
  /** Open for append, creating with mode 0600 if absent (`wx` semantic NOT required). */
  openAppend(path: string): Promise<AppendHandle>;
  /** Create a NEW file exclusively (fails if it exists), mode 0600. */
  openNew(path: string): Promise<AppendHandle>;
  /** fsync a directory so a create/rename in it is durable. */
  syncDir(path: string): Promise<void>;
}

function wrap(fh: FileHandle): AppendHandle {
  return {
    write: async (data) => {
      let off = 0;
      while (off < data.length) off += (await fh.write(data, off, data.length - off)).bytesWritten;
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  };
}

export const defaultFileOps: FileOps = {
  openAppend: async (path) => wrap(await open(path, 'a', 0o600)),
  openNew: async (path) => wrap(await open(path, 'wx', 0o600)),
  syncDir: async (path) => {
    let fh: FileHandle | undefined;
    try {
      fh = await open(path, 'r');
      await fh.sync();
    } catch {
      /* some platforms (Windows) cannot fsync a directory; the file fsync still stands. Documented limitation. */
    } finally {
      await fh?.close();
    }
  },
};

export interface RetentionPolicy {
  /** `retainUntil` = recordedAt + this. REQUIRED — no default is invented. */
  readonly defaultRetentionMs: number;
  /** Purge never removes a record younger than this, whatever `retainUntil` says. REQUIRED. */
  readonly minimumRetentionMs: number;
}

export interface FileAuditStoreOptions {
  readonly dir: string;
  readonly retention: RetentionPolicy;
  readonly clock?: () => Date;
  readonly ops?: FileOps;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  /** Max age of an access grant at the moment the store consumes it. Default 30s. */
  readonly grantMaxAgeMs?: number;
}

export interface ReadQuery {
  readonly correlationId?: string;
  readonly executionId?: string;
  readonly afterSeq?: number;
  readonly limit?: number;
}
export interface ReadResult {
  readonly events: readonly AuditEvent[];
  /** Lines that were not valid events (e.g. a torn tail from a crash mid-write). Reported, never silently dropped. */
  readonly corruptLines: number;
}
export interface PurgeResult {
  readonly purged: number;
  readonly retained: number;
  /** Receipt-bearing marker event; absent when nothing was purged. */
  readonly marker?: AuditEvent;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
const unavailable = (msg: string, cause?: unknown): AuditError =>
  new AuditError(ErrorCode.AUDIT_UNAVAILABLE, msg, cause === undefined ? undefined : { cause });

function parseStored(line: string): AuditEvent | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (
      v['schemaVersion'] === AUDIT_SCHEMA_VERSION &&
      typeof v['eventId'] === 'string' &&
      typeof v['seq'] === 'number' &&
      Number.isInteger(v['seq']) &&
      typeof v['recordedAt'] === 'string' &&
      typeof v['retainUntil'] === 'string' &&
      typeof v['type'] === 'string' &&
      EVENT_TYPE_SET.has(v['type'])
    )
      return v as unknown as AuditEvent;
  } catch {
    /* fallthrough */
  }
  return undefined;
}

/**
 * File-backed audit store: one append-only JSONL file (`audit.jsonl`, mode 0600, directory 0700).
 *
 * WHAT A RECEIPT FROM THIS STORE GUARANTEES — and no more:
 *  - the event line was appended to `audit.jsonl` and `fsync`ed (file data flushed to stable storage as the OS
 *    reports it) BEFORE `append` resolved ok. A confirmed receipt therefore survives a process crash or kill.
 *  - `seq` is strictly increasing and gap-free between purges, assigned under an exclusive write lock.
 * LIMITS (do not over-claim):
 *  - Not tamper-proof: no hash chain/signature (out of M4 scope). Anyone with filesystem write access can alter the file.
 *  - Power-loss/media durability is as good as the OS/disk honour fsync.
 *  - Cross-process safety is a best-effort advisory lock file (`audit.lock`, exclusive create) with stale-lock
 *    stealing; it holds on a local POSIX filesystem, NOT on NFS/SMB, and a stolen stale lock can race. Run ONE
 *    writer process per directory for strong guarantees.
 *  - A crash between a protected operation's side effect and its completion append leaves NO completion event; the
 *    store cannot know. That window is closed only by reconciliation (see docs/audit-operations.md).
 *  - A failed append is INDETERMINATE (bytes may have landed). Use `idempotencyKey` to retry safely.
 *  - A torn tail from a crash mid-write is detected, terminated with a newline before the next event, and reported
 *    as a corrupt line on read — never silently repaired or dropped.
 */
export class FileAuditStore implements AuditSink {
  readonly mode = 'durable' as const;
  readonly storeId: string;
  private readonly file: string;
  private readonly lockFile: string;
  private readonly clock: () => Date;
  private readonly ops: FileOps;
  private chain: Promise<unknown> = Promise.resolve();
  // scan state (single source of truth is the file; this is a cache of what we've parsed)
  private scanned = 0;
  private lastSeq = 0;
  private torn = false;
  private corrupt = 0;
  private readonly keyIndex = new Map<string, AuditEvent>();

  private constructor(private readonly options: FileAuditStoreOptions) {
    this.file = join(options.dir, 'audit.jsonl');
    this.lockFile = join(options.dir, 'audit.lock');
    this.clock = options.clock ?? (() => new Date());
    this.ops = options.ops ?? defaultFileOps;
    this.storeId = createHash('sha256').update(resolve(options.dir)).digest('hex').slice(0, 16);
  }

  /** Validates retention policy (REQUIRED) and prepares the directory with restrictive permissions. */
  static async open(options: FileAuditStoreOptions): Promise<FileAuditStore> {
    const r = options.retention as Partial<RetentionPolicy> | undefined;
    if (
      r === undefined ||
      typeof r.defaultRetentionMs !== 'number' ||
      typeof r.minimumRetentionMs !== 'number' ||
      !(r.minimumRetentionMs > 0) ||
      !(r.defaultRetentionMs >= r.minimumRetentionMs) ||
      !Number.isFinite(r.defaultRetentionMs)
    ) {
      throw new AuditError(
        ErrorCode.AUDIT_CONFIG_INVALID,
        'a retention policy (default >= minimum > 0) is required to open a durable audit store',
      );
    }
    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      await chmod(options.dir, 0o700);
    } catch (cause) {
      throw new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, 'audit directory could not be prepared', { cause });
    }
    return new FileAuditStore(options);
  }

  // ── serialization + locking ──────────────────────────────────────────
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const timeout = this.options.lockTimeoutMs ?? 5000;
    const stale = this.options.staleLockMs ?? 30_000;
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      try {
        const h = await open(this.lockFile, 'wx', 0o600);
        await h.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        await h.close();
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable('audit lock could not be created', cause);
        try {
          const st = await stat(this.lockFile);
          if (Date.now() - st.mtimeMs > stale) {
            await rm(this.lockFile, { force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between checks
        }
        if (Date.now() - started > timeout) throw unavailable('audit write lock timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        const body = JSON.parse(await readFile(this.lockFile, 'utf8')) as { token?: string };
        if (body.token === token) await rm(this.lockFile, { force: true });
      } catch {
        /* lock already gone */
      }
    }
  }

  // ── scanning (the file is authoritative) ─────────────────────────────
  private resetScan(): void {
    this.scanned = 0;
    this.lastSeq = 0;
    this.torn = false;
    this.corrupt = 0;
    this.keyIndex.clear();
  }

  private async catchUp(): Promise<void> {
    let fh: FileHandle;
    try {
      fh = await open(this.file, 'r');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.resetScan();
        return;
      }
      throw unavailable('audit file could not be read', cause);
    }
    try {
      const size = (await fh.stat()).size;
      if (size < this.scanned) this.resetScan(); // shrank (purge by another process, or tampering): rescan
      if (size === this.scanned) return;
      const buf = Buffer.alloc(size - this.scanned);
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, this.scanned + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      let start = 0;
      for (let i = 0; i < off; i++) {
        if (buf[i] !== 0x0a) continue;
        const line = buf.subarray(start, i).toString('utf8');
        start = i + 1;
        if (line.length === 0) continue;
        const ev = parseStored(line);
        if (ev === undefined) this.corrupt++;
        else {
          if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
          if (ev.idempotencyKey !== undefined) this.keyIndex.set(ev.idempotencyKey, ev);
        }
      }
      this.scanned += start;
      this.torn = start < off;
    } finally {
      await fh.close();
    }
  }

  private retainUntil(recordedAt: Date): string {
    return new Date(recordedAt.getTime() + this.options.retention.defaultRetentionMs).toISOString();
  }

  // ── append ───────────────────────────────────────────────────────────
  async append(draft: AuditEventDraft): Promise<AppendResult> {
    const valid = validateDraft(draft);
    if (!valid.ok) return { ok: false, error: valid.error, indeterminate: false };
    try {
      return await this.serialized(() => this.withLock(() => this.appendLocked(valid.value)));
    } catch (cause) {
      const error = cause instanceof AuditError ? cause : unavailable('audit append failed', cause);
      return { ok: false, error, indeterminate: false };
    }
  }

  private async appendLocked(draft: AuditEventDraft): Promise<AppendResult> {
    await this.catchUp();
    const sameFile = async (): Promise<boolean> =>
      stat(this.file).then(
        () => true,
        () => false,
      );
    if (draft.idempotencyKey !== undefined) {
      const existing = this.keyIndex.get(draft.idempotencyKey);
      if (existing !== undefined) {
        // The earlier attempt may have written but not synced. Confirm with fsync BEFORE minting a receipt.
        try {
          const h = await this.ops.openAppend(this.file);
          try {
            await h.sync();
          } finally {
            await h.close();
          }
        } catch (cause) {
          return { ok: false, error: unavailable('audit write could not be confirmed', cause), indeterminate: true };
        }
        return {
          ok: true,
          event: existing,
          receipt: mintReceipt({
            eventId: existing.eventId,
            seq: existing.seq,
            storeId: this.storeId,
            recordedAt: existing.recordedAt,
            guarantee: 'fsync-file',
          }),
        };
      }
    }
    const created = !(await sameFile());
    const now = this.clock();
    const event = buildEvent(draft, {
      eventId: randomUUID(),
      seq: this.lastSeq + 1,
      recordedAt: now.toISOString(),
      retainUntil: this.retainUntil(now),
    });
    const bytes = Buffer.from(`${this.torn ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8');
    let handle: AppendHandle | undefined;
    try {
      handle = await this.ops.openAppend(this.file);
      await handle.write(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (created) await this.ops.syncDir(this.options.dir);
    } catch (cause) {
      try {
        await handle?.close();
      } catch {
        /* ignore */
      }
      return { ok: false, error: unavailable('audit write could not be confirmed durable', cause), indeterminate: true };
    }
    return {
      ok: true,
      event,
      receipt: mintReceipt({
        eventId: event.eventId,
        seq: event.seq,
        storeId: this.storeId,
        recordedAt: event.recordedAt,
        guarantee: 'fsync-file',
      }),
    };
  }

  // ── read (authorized) ────────────────────────────────────────────────
  async read(grant: unknown, query: ReadQuery = {}): Promise<Result<ReadResult, AuditError>> {
    const g = consumeGrant(grant, 'read', Date.now(), this.options.grantMaxAgeMs ?? 30_000);
    if (!g.ok) return g;
    try {
      return await this.serialized(async () => {
        const text = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return '';
          throw e;
        });
        const events: AuditEvent[] = [];
        let corruptLines = 0;
        for (const line of text.split('\n')) {
          if (line.length === 0) continue;
          const ev = parseStored(line);
          if (ev === undefined) {
            corruptLines++;
            continue;
          }
          if (query.correlationId !== undefined && ev.correlationId !== query.correlationId) continue;
          if (query.executionId !== undefined && ev.executionId !== query.executionId) continue;
          if (query.afterSeq !== undefined && ev.seq <= query.afterSeq) continue;
          events.push(ev);
        }
        const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
        return ok({ events: events.slice(0, limit), corruptLines });
      });
    } catch (cause) {
      return err(unavailable('audit records could not be read', cause));
    }
  }

  // ── purge (authorized; enforces retention) ───────────────────────────
  /**
   * Removes records that are BOTH past `retainUntil` AND older than the configured minimum retention. The rewrite
   * is atomic (temp file + fsync + rename + dir fsync): a crash leaves either the old file or the new one, never a
   * mix. A tamper-evident-by-count marker event (`audit.purged`: counts and seq range only — no content) is part of
   * the new file. Purge removes data by policy; it never rewrites surviving events.
   */
  async purge(grant: unknown): Promise<Result<PurgeResult, AuditError>> {
    const g = consumeGrant(grant, 'purge', Date.now(), this.options.grantMaxAgeMs ?? 30_000);
    if (!g.ok) return g;
    try {
      return await this.serialized(() =>
        this.withLock(async () => {
          await this.catchUp();
          const text = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return '';
            throw e;
          });
          const now = this.clock();
          const keep: string[] = [];
          let purged = 0;
          let first = Infinity;
          let last = 0;
          for (const line of text.split('\n')) {
            if (line.length === 0) continue;
            const ev = parseStored(line);
            const recorded = ev === undefined ? NaN : Date.parse(ev.recordedAt);
            const until = ev === undefined ? NaN : Date.parse(ev.retainUntil);
            const expired =
              ev !== undefined &&
              Number.isFinite(recorded) &&
              Number.isFinite(until) &&
              until <= now.getTime() &&
              recorded + this.options.retention.minimumRetentionMs <= now.getTime();
            if (expired && ev !== undefined) {
              purged++;
              first = Math.min(first, ev.seq);
              last = Math.max(last, ev.seq);
            } else keep.push(line); // unparsable fragments are kept (unjudgeable) and stay reported as corrupt
          }
          if (purged === 0) return ok({ purged: 0, retained: keep.length });
          const marker = buildEvent(
            {
              type: 'audit.purged',
              action: 'audit.purge',
              outcome: 'completed',
              actor: {
                kind: g.value.principalKind,
                id: g.value.principalId,
                ...(g.value.orgId !== undefined ? { orgId: g.value.orgId } : {}),
              } as AuditEventDraft['actor'],
              target: { kind: 'audit-log', id: this.storeId },
              metadata: { purgedCount: purged, firstSeq: first, lastSeq: last },
            },
            { eventId: randomUUID(), seq: this.lastSeq + 1, recordedAt: now.toISOString(), retainUntil: this.retainUntil(now) },
          );
          const tmp = `${this.file}.tmp-${randomUUID()}`;
          const h = await this.ops.openNew(tmp);
          try {
            await h.write(Buffer.from([...keep, JSON.stringify(marker)].join('\n') + '\n', 'utf8'));
            await h.sync();
          } finally {
            await h.close();
          }
          try {
            await rename(tmp, this.file);
          } catch (cause) {
            await rm(tmp, { force: true });
            throw cause;
          }
          await this.ops.syncDir(this.options.dir);
          this.resetScan();
          return ok({ purged, retained: keep.length, marker });
        }),
      );
    } catch (cause) {
      return err(cause instanceof AuditError ? cause : unavailable('audit purge failed', cause));
    }
  }
}

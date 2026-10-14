import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHAIN_LOCK_FILE,
  CHAIN_LOG_FILE,
  verifyClosedChainedLog,
  type ChainCheckpoint,
  type ChainVerifyReport,
  type ChainedAuditStore,
  type FileOps,
} from '@xo/audit';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  auditError,
  type AuditError,
  type AuditReceipt,
  type AuditRecorder,
  type AuditRecordRequest,
  type AuditTrust,
} from './audit.js';
import {
  CanonicalAuditRecorder,
  EI_AUDIT_EXTENSION_SCHEMA,
  EI_AUDIT_NAMESPACE,
  openEiAuditStore,
  toEiAuditError,
} from './audit-canonical.js';

/**
 * C0.3 — COMPATIBILITY SHIM. EI no longer has its own log, hash chain, lock, scanner or lifecycle engine. `FileAuditLog`
 * is a thin, deprecated facade over the canonical `@xo/audit` `ChainedAuditStore` (opened through `openEiAuditStore`), so
 * there is exactly one authoritative writable history and every guarantee below is the canonical store's guarantee.
 *
 * New code should use `openEiAuditStore` + `CanonicalAuditRecorder` (audit-canonical.ts) directly.
 *
 * Behavioral differences from the pre-C0.3 `FileAuditLog`, all deliberate:
 *  - `record(event, trust)` REQUIRES the authenticated principal; the request snapshot alone is never trusted.
 *  - There is no unauthenticated read of a log. `readAuditLog` was removed. Live reads go through `@xo/audit`
 *    `ChainedAuditStore.read(grant)`; `verifyAuditLog` (below) is an operator-local check of a CLOSED file only.
 *  - The on-disk file is `audit.chain.jsonl` in the canonical format. A pre-C0.3 `audit.log` is NOT migrated: opening a
 *    directory that contains one is refused, so two histories can never coexist. (No production code wrote one.)
 *  - `ioHooks`, `recoverTornTail` and `maxLogBytes` were removed with the code they configured. A torn tail is always
 *    cut back and recorded as a `recovery` record; fault injection uses the `ops` (`FileOps`) seam.
 */
export const AUDIT_LOG_FILE = CHAIN_LOG_FILE;
export const AUDIT_LOCK_FILE = CHAIN_LOCK_FILE;
const LEGACY_LOG_FILE = 'audit.log';

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

export type AuditCheckpoint = ChainCheckpoint;
export type AuditVerificationReport = ChainVerifyReport;

export interface FileAuditLogOptions {
  readonly dir: string;
  /** Secret key (>= 32 bytes) for HMAC-SHA-256 chaining. A log is permanently either keyed or unkeyed. */
  readonly integrityKey?: Uint8Array;
  /** The canonical store never deletes, so retention is effectively indefinite; a finite policy is validated against evidence retention only. */
  readonly retention?: AuditRetentionPolicy;
  /** If set, `open` refuses a finite audit retention shorter than this. */
  readonly evidenceRetentionMs?: number;
  readonly now?: () => Date;
  /** Fault-injection seam (platform `FileOps`). Production code passes nothing. */
  readonly ops?: FileOps;
}

/** @deprecated Use `openEiAuditStore` and `CanonicalAuditRecorder`. Delegates to the canonical store. */
export class FileAuditLog implements AuditRecorder {
  private constructor(
    private readonly store: ChainedAuditStore,
    private readonly recorder: CanonicalAuditRecorder,
  ) {}

  static async open(options: FileAuditLogOptions): Promise<Result<FileAuditLog, AuditError>> {
    const retention = options.retention ?? { mode: 'indefinite' as const };
    if (options.evidenceRetentionMs !== undefined) {
      const aligned = assertRetentionAligned(retention, options.evidenceRetentionMs);
      if (!aligned.ok) return aligned;
    }
    if (retention.mode === 'minimum' && !(Number.isFinite(retention.minimumMs) && retention.minimumMs >= 0)) {
      return err(auditError(AuditErrorCode.INVALID_CONFIG, 'retention must be a non-negative finite duration'));
    }
    const legacy = await stat(join(options.dir, LEGACY_LOG_FILE)).then(
      () => true,
      () => false,
    );
    if (legacy) {
      return err(
        auditError(
          AuditErrorCode.INVALID_CONFIG,
          'a pre-C0.3 audit.log exists in this directory; it is not migrated and would create a second history',
        ),
      );
    }
    const store = await openEiAuditStore({
      dir: options.dir,
      ...(options.integrityKey !== undefined ? { integrityKey: options.integrityKey } : {}),
      ...(options.now !== undefined ? { clock: options.now } : {}),
      ...(options.ops !== undefined ? { ops: options.ops } : {}),
    });
    if (!store.ok) return store;
    return ok(new FileAuditLog(store.value, new CanonicalAuditRecorder(store.value)));
  }

  record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    return this.recorder.record(event, trust);
  }

  /** The head (counts + hash, no content). Persist it where the log's writer cannot rewrite it. */
  checkpoint(): AuditCheckpoint {
    return this.store.checkpoint();
  }

  openAttempts(): readonly string[] {
    return this.store.openAttempts();
  }

  get recoveries(): number {
    return this.store.recoveryCount;
  }

  /** The canonical store, for authorized reads (`store.read(grant)` / `store.verify(grant)`). */
  get canonical(): ChainedAuditStore {
    return this.store;
  }

  close(): Promise<void> {
    return this.store.close();
  }
}

export interface VerifyOptions {
  readonly integrityKey?: Uint8Array;
  /** An externally held checkpoint; a mismatch (including a shorter chain) fails verification. */
  readonly expectedHead?: AuditCheckpoint;
}

/**
 * OPERATOR-LOCAL verification of a CLOSED log file. It refuses a directory held by a live writer, so it cannot be used to
 * read around the authorization of a live store. Failure (including any integrity failure) is an error, never a report
 * that "mostly" verified.
 */
export async function verifyAuditLog(dir: string, options: VerifyOptions = {}): Promise<Result<AuditVerificationReport, AuditError>> {
  const r = await verifyClosedChainedLog(dir, {
    extensionSchemas: { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA },
    ...(options.integrityKey !== undefined ? { integrityKey: options.integrityKey } : {}),
    ...(options.expectedHead !== undefined ? { expectedHead: options.expectedHead } : {}),
  });
  return r.ok ? ok(r.value) : err(toEiAuditError(r.error));
}

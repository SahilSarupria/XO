import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, type StorageError } from '@xo/errors';
import type { AtomicBlobStore } from '@xo/storage';
import {
  isValidProcedureId,
  parseApprovalRecord,
  parseVersionRecord,
  type ProcedureApprovalRecord,
  type ProcedureVersionRecord,
  type StoredLookup,
} from './procedure.js';

const defKey = (id: string, version: number): string => `${id}/v${version}/definition.json`;
const approvalKey = (id: string, version: number): string => `${id}/v${version}/approval.json`;

/**
 * Per-workspace local store. Versions are immutable (`putIfAbsent`, atomic link); approvals are replaced atomically (temp + rename).
 * Callers MUST pass ids that already satisfied `isValidProcedureId` / `parseVersionParam`; the store re-checks and refuses otherwise.
 */
export class FsProcedureStore {
  constructor(
    private readonly store: AtomicBlobStore,
    private readonly workspaceId: string,
  ) {}

  async createVersion(record: ProcedureVersionRecord): Promise<Result<{ readonly created: boolean }, StorageError>> {
    if (!isValidProcedureId(record.procedureId)) throw new TypeError('invalid procedure id');
    return this.store.putIfAbsent(defKey(record.procedureId, record.version), JSON.stringify(record), { contentType: 'application/json' });
  }

  async getVersion(procedureId: string, version: number): Promise<Result<StoredLookup<ProcedureVersionRecord>, StorageError>> {
    if (!isValidProcedureId(procedureId)) return ok({ kind: 'none' });
    const raw = await this.store.get(defKey(procedureId, version));
    if (!raw.ok) return raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND ? ok({ kind: 'none' }) : err(raw.error);
    try {
      return ok(
        parseVersionRecord(JSON.parse(new TextDecoder().decode(raw.value)), { workspaceId: this.workspaceId, procedureId, version }),
      );
    } catch {
      return ok({ kind: 'malformed' });
    }
  }

  async putApproval(record: ProcedureApprovalRecord): Promise<Result<unknown, StorageError>> {
    if (!isValidProcedureId(record.procedureId)) throw new TypeError('invalid procedure id');
    return this.store.replace(approvalKey(record.procedureId, record.version), JSON.stringify(record), { contentType: 'application/json' });
  }

  async getApproval(procedureId: string, version: number): Promise<Result<StoredLookup<ProcedureApprovalRecord>, StorageError>> {
    if (!isValidProcedureId(procedureId)) return ok({ kind: 'none' });
    const raw = await this.store.get(approvalKey(procedureId, version));
    if (!raw.ok) return raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND ? ok({ kind: 'none' }) : err(raw.error);
    try {
      return ok(
        parseApprovalRecord(JSON.parse(new TextDecoder().decode(raw.value)), { workspaceId: this.workspaceId, procedureId, version }),
      );
    } catch {
      return ok({ kind: 'malformed' });
    }
  }

  /** Procedure ids → ascending version numbers, derived from the definition files that exist (temp files are ignored). */
  async listAll(): Promise<Result<ReadonlyMap<string, readonly number[]>, StorageError>> {
    const keys = await this.store.list('');
    if (!keys.ok) return keys.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND ? ok(new Map()) : err(keys.error);
    const out = new Map<string, number[]>();
    for (const key of keys.value) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*)\/v([1-9][0-9]*)\/definition\.json$/.exec(key.split('\\').join('/'));
      if (m === null || !isValidProcedureId(m[1])) continue;
      const list = out.get(m[1] as string) ?? [];
      list.push(Number(m[2]));
      out.set(m[1] as string, list);
    }
    for (const v of out.values()) v.sort((a, b) => a - b);
    return ok(out);
  }
}

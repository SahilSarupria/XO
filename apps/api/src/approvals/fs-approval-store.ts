import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import type { XoError } from '@xo/errors';
import { ErrorCode } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import {
  APPROVAL_SCHEMA_VERSION,
  parseApprovalRecord,
  type ApprovalDraft,
  type ApprovalLookup,
  type ApprovalRecord,
  type ApprovalStore,
} from './approval.js';

/**
 * One JSON record per (compilationId, capabilityId) pair. Re-approving the same pair REPLACES the record — which is exactly what
 * "approve it again after it changed" means; the superseded approval's history lives in the audit trail (`approval.granted`), not
 * here. Ids are URL-encoded into the key, and both are validated against the compilation's own persisted capability list by the
 * approve route before this store is reached.
 */
function key(compilationId: string, capabilityId: string): string {
  return `${encodeURIComponent(compilationId)}/${encodeURIComponent(capabilityId)}.json`;
}

export class FsApprovalStore implements ApprovalStore {
  constructor(private readonly store: BlobStore) {}

  async approve(draft: ApprovalDraft): Promise<Result<ApprovalRecord, XoError>> {
    const record: ApprovalRecord = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      compilationId: draft.compilationId,
      capabilityId: draft.capabilityId,
      workspaceId: draft.workspaceId,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approver: draft.approver,
      identityId: draft.approver.id,
      approverIdentityId: draft.approver.id,
      binding: draft.binding,
    };
    const put = await this.store.put(key(draft.compilationId, draft.capabilityId), JSON.stringify(record), {
      contentType: 'application/json',
    });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async lookup(compilationId: string, capabilityId: string): Promise<Result<ApprovalLookup, XoError>> {
    const raw = await this.store.get(key(compilationId, capabilityId));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok({ kind: 'none' });
      return err(raw.error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.value));
    } catch {
      return ok({ kind: 'malformed' });
    }
    return ok(parseApprovalRecord(parsed));
  }
}

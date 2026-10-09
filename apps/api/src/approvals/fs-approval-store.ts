import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import type { ApprovalRecord, ApprovalStore } from './approval.js';

/**
 * One JSON record per (compilationId, capabilityId) pair — capability
 * ids are compiler-assigned XOIR node ids, which are already safe,
 * opaque strings (no path-separator/traversal characters — enforced by
 * `@xo/xoir`'s own id construction, upstream of this file), so no
 * additional id-validation layer is needed here the way `isValidSourceId`/
 * `isValidWorkspaceId` add one for server-minted ids: this key is
 * composed from two values the workspace's own compilation/capability
 * lookups have already validated by the time this store is ever called
 * (see `approval-routes.ts`, which always resolves+checks the
 * capability against the compilation's own persisted list before
 * reaching this store).
 */
function key(compilationId: string, capabilityId: string): string {
  return `${encodeURIComponent(compilationId)}/${encodeURIComponent(capabilityId)}.json`;
}

function decodeRecord(bytes: Uint8Array): ApprovalRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ApprovalRecord;
  } catch {
    return undefined;
  }
}

export class FsApprovalStore implements ApprovalStore {
  constructor(private readonly store: BlobStore) {}

  async approve(compilationId: string, capabilityId: string, workspaceId: string, identityId: string): Promise<Result<ApprovalRecord, XoError>> {
    const record: ApprovalRecord = {
      compilationId,
      capabilityId,
      workspaceId,
      identityId,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approverIdentityId: identityId,
    };
    const put = await this.store.put(key(compilationId, capabilityId), JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async get(compilationId: string, capabilityId: string): Promise<Result<ApprovalRecord | undefined, XoError>> {
    const raw = await this.store.get(key(compilationId, capabilityId));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok(undefined);
      return err(raw.error);
    }
    return ok(decodeRecord(raw.value));
  }
}

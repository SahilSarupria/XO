/**
 * UW-10c (ADR 0042) — attachments are workspace sources, found by the SHA-256 of their stored bytes. The send re-reads the bytes and
 * re-hashes them (`loadAttachments`), so an approved hash can only ever send exactly those bytes.
 */
import { FsSourceStore } from '../sources/fs-source-store.js';
import { workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { AttachmentStore } from '@xo/connectors';

export function workspaceAttachmentStore(workspace: WorkspaceRecord, config: WorkspaceDataConfig): AttachmentStore {
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  return {
    async read(sha256) {
      const all = await sources.list();
      if (!all.ok) return undefined;
      const hit = all.value.find((s) => s.digestSha256 === sha256 && s.retired === undefined);
      if (hit === undefined) return undefined;
      const bytes = await sources.getContent(hit.sourceId);
      return bytes.ok ? bytes.value : undefined;
    },
  };
}

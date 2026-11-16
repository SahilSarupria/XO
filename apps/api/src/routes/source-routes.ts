import { extname } from 'node:path';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES, UploadSessionStore, type UploadSession } from '../sources/upload-sessions.js';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requirePermission,
  requireOwnedWorkspace,
  workspaceSourcesStore,
  workspaceUploadsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { recordAudit } from '../audit/record.js';
import { safeFetch, type LookupFn, type TransportFn } from '../sources/safe-fetch.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { workspaceStateStore } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { auditedRead, type AuditService } from '../audit/audit-service.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { EXTENSION_FOR_MEDIA_TYPE, SUPPORTED_EXTENSIONS, inferMediaType, type SourceRecord } from '../sources/source.js';
import { storeSourceBytes, type StoreContext } from '../sources/ingest.js';

/**
 * Source registration and storage only — no compilation happens here
 * (per the milestone brief; `@xo/compiler`'s `compileSources` is not
 * called anywhere in this file). Every handler resolves storage
 * exclusively through `requireOwnedWorkspace` + `workspaceSourcesStore`
 * (the same P0.2 pattern `package-routes.ts`/`registry-routes.ts` use),
 * so a `SourceStore` this file ever constructs is already scoped to
 * exactly one ownership-checked workspace before a byte is read or
 * written.
 *
 * Upload shape: the request body is the raw file bytes (not JSON,
 * not multipart) — the same "raw bytes in, `Content-Type` header
 * describes them" shape `registry-routes.ts#publish` already uses for
 * `.xo` archives, reusing `req.rawBody()`'s existing buffering and
 * 64MB cap (`http/body.ts`) rather than adding a new upload mechanism.
 * The original filename travels as a `?filename=` query parameter —
 * metadata only, never used to build a storage path (the server-
 * generated `sourceId` is what's used for that; see `fs-source-store.ts`).
 */

import { safeOriginLabel } from '../sources/ingest.js';
export { safeOriginLabel };

function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: XoError }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Wire shape is identical to `SourceRecord` today — kept as its own function for the same future-proofing reason `workspace-routes.ts#toWireRecord` is. */
function toWireRecord(record: SourceRecord): SourceRecord {
  return record;
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export interface SourceRouteOptions {
  /** Injection seam for the URL importer's DNS lookup and HTTPS transport. Production passes nothing; tests pass fakes so no test touches the network. */
  readonly fetchDeps?: { readonly lookup?: LookupFn; readonly transport?: TransportFn };
}

/**
 * A filename is metadata, never a path: anything that even looks like it is smuggling a directory component is refused, and only
 * supported extensions are accepted. Shared by single-request and resumable uploads.
 */
function acceptedFilename(raw: string | null | undefined): { filename: string; extension: string } {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'query parameter "filename" (the original filename) is required');
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"filename" must not contain path separators or ".."');
  }
  const extension = extname(raw).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      `unsupported file extension "${extension || '(none)'}" — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }
  return { filename: raw, extension };
}

export function registerSourceRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  options: SourceRouteOptions = {},
): void {
  const fetchDeps = options.fetchDeps ?? {};
  async function upload(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'upload source' });

    const { filename, extension } = acceptedFilename(req.query.get('filename'));

    const bytes = await req.rawBody();
    if (bytes.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body is empty; a non-empty file upload is required');
    }

    const mediaType = inferMediaType(extension, req.headers['content-type']);
    const created = await storeSource(req, workspace, filename, extension, mediaType, new Uint8Array(bytes), { kind: 'upload' });
    return json(201, toWireRecord(created));
  }

  const storeContext = (req: ApiRequest, workspace: Parameters<typeof workspaceSourcesStore>[0]): StoreContext => ({
    workspace,
    dataConfig,
    identityId: callerIdentityId(req),
    audit: (entry) => recordAudit(req, workspace, dataConfig, entry),
  });
  const storeSource = (
    req: ApiRequest,
    workspace: Parameters<typeof workspaceSourcesStore>[0],
    filename: string,
    extension: string,
    mediaType: string,
    bytes: Uint8Array,
    origin: NonNullable<SourceRecord['origin']>,
  ): Promise<SourceRecord> => storeSourceBytes(storeContext(req, workspace), filename, extension, mediaType, bytes, origin);

  async function importFromUrl(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'import source from link' });
    const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
    if (settings.airGapped) {
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        'this workspace is in air-gapped mode: importing from a link is disabled (upload the file instead)',
      );
    }
    const bodyResult = await req.json<{ url?: unknown; filename?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const { url, filename: requestedName } = bodyResult.value ?? {};
    if (typeof url !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"url" (string) is required');
    if (requestedName !== undefined && typeof requestedName !== 'string')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"filename", if present, must be a string');
    if (
      typeof requestedName === 'string' &&
      (requestedName.includes('/') || requestedName.includes('\\') || requestedName.includes('..'))
    ) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"filename" must not contain path separators or ".."');
    }

    const fetched = await safeFetch(url, fetchDeps);
    const contentType = fetched.contentType?.split(';')[0]?.trim().toLowerCase();

    let name = typeof requestedName === 'string' && requestedName.trim().length > 0 ? requestedName.trim() : undefined;
    if (name === undefined) {
      const last = decodeURIComponent(new URL(fetched.finalUrl).pathname.split('/').filter(Boolean).pop() ?? '');
      name = last.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
    }
    let extension = extname(name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      const fromType = contentType !== undefined ? EXTENSION_FOR_MEDIA_TYPE[contentType] : undefined;
      if (fromType === undefined) {
        throw new XoError(
          ErrorCode.INVALID_ARGUMENT,
          `cannot tell what kind of file this link is (content type "${contentType ?? 'unknown'}"); supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        );
      }
      const stem = name.length > 0 && extension === '' ? name : name.replace(/\.[^.]*$/, '');
      name = `${stem.length > 0 ? stem : 'imported'}${fromType}`;
      extension = fromType;
    }
    const mediaType = inferMediaType(extension, contentType);
    const created = await storeSource(req, workspace, name, extension, mediaType, fetched.bytes, {
      kind: 'url',
      url: safeOriginLabel(fetched.finalUrl),
    });
    return json(201, toWireRecord(created));
  }

  async function listSources(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    return json(200, { sources: listed.value.map(toWireRecord) });
  }

  /**
   * PX-1 (ADR 0029 decision 1): source versions. A version is the bytes (its SHA-256); each upload or import that delivered
   * those bytes stays its own record, with its own origin, uploader and time — nothing is merged away.
   */
  async function listSourceVersions(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    const byDigest = new Map<string, SourceRecord[]>();
    for (const r of listed.value) byDigest.set(r.digestSha256, [...(byDigest.get(r.digestSha256) ?? []), r]);
    const versions = [...byDigest.entries()]
      .map(([digestSha256, records]) => ({
        digestSha256,
        byteSize: records[0]!.byteSize,
        firstSeenAt: records.map((r) => r.createdAt).sort()[0]!,
        records: records
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((r) => ({
            sourceId: r.sourceId,
            originalFilename: r.originalFilename,
            createdAt: r.createdAt,
            origin: r.origin ?? { kind: 'upload' },
          })),
      }))
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
    return json(200, { versions });
  }

  async function getSource(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const found = unwrapOrThrow(await store.get(sourceId));
    return json(200, toWireRecord(found));
  }

  async function getSourceContent(req: ApiRequest): Promise<ApiResponse> {
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
    // P1.0 M4 — raw user documents: the most sensitive read surface. Owner check -> durable access.attempted -> read.
    return auditedRead(
      req,
      { audit, workspaceStore },
      { action: 'read.source-content', kind: 'source', idParam: 'sourceId' },
      async (workspace) => {
        const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
        const record = unwrapOrThrow(await store.get(sourceId));
        const content = unwrapOrThrow(await store.getContent(sourceId));
        return {
          status: 200,
          body: Buffer.from(content),
          headers: {
            'content-type': record.mediaType,
            'content-disposition': `attachment; filename="${record.originalFilename.replace(/"/g, '')}"`,
          },
        };
      },
    );
  }

  async function deleteSource(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, {
      action: 'delete source',
      target: { kind: 'source', id: req.params['sourceId'] ?? '' },
    });
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const deleted = await store.delete(sourceId);
    if (!deleted.ok) throw deleted.error;
    await recordAudit(req, workspace, dataConfig, {
      event: 'source.deleted',
      result: 'succeeded',
      target: { kind: 'source', id: sourceId },
    });
    return { status: 204 };
  }

  // ── UW-3: resumable uploads ─────────────────────────────────────────────────────────────────────────────────────
  async function uploadContext(req: ApiRequest) {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'upload source' });
    return { workspace, sessions: new UploadSessionStore(workspaceUploadsStore(workspace, dataConfig)), identityId: callerIdentityId(req) };
  }
  const sessionWire = (s: UploadSession) => ({
    uploadId: s.uploadId,
    filename: s.filename,
    size: s.size,
    offset: s.offset,
    expiresAt: s.expiresAt,
    maxChunkBytes: MAX_UPLOAD_CHUNK_BYTES,
  });

  async function openUpload(req: ApiRequest): Promise<ApiResponse> {
    const { sessions, identityId } = await uploadContext(req);
    const parsed = await req.json<{ filename?: unknown; size?: unknown; sha256?: unknown; mediaType?: unknown }>();
    if (!parsed.ok) throw parsed.error;
    const body = parsed.value ?? {};
    const { filename, extension } = acceptedFilename(typeof body.filename === 'string' ? body.filename : undefined);
    const size = body.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `"size" must be the file's size in bytes, 1 to ${MAX_UPLOAD_BYTES}`);
    }
    const sha256 = body.sha256;
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"sha256" must be 64 lower-case hex characters');
    }
    const mediaType = inferMediaType(extension, typeof body.mediaType === 'string' ? body.mediaType : undefined);
    const session = await sessions.open({ identityId, filename, extension, mediaType, size, ...(sha256 !== undefined ? { sha256 } : {}) });
    return json(201, sessionWire(session));
  }

  async function uploadStatus(req: ApiRequest): Promise<ApiResponse> {
    const { sessions, identityId } = await uploadContext(req);
    return json(200, sessionWire(await sessions.get(req.params['uploadId'] ?? '', identityId)));
  }

  async function uploadChunk(req: ApiRequest): Promise<ApiResponse> {
    const { sessions, identityId } = await uploadContext(req);
    const session = await sessions.get(req.params['uploadId'] ?? '', identityId);
    const offset = Number(req.query.get('offset'));
    if (req.query.get('offset') === null || !Number.isInteger(offset) || offset < 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'query parameter "offset" (where this chunk starts) is required');
    }
    const bytes = await req.rawBody();
    return json(200, sessionWire(await sessions.append(session, offset, new Uint8Array(bytes))));
  }

  async function completeUpload(req: ApiRequest): Promise<ApiResponse> {
    const { workspace, sessions, identityId } = await uploadContext(req);
    const session = await sessions.get(req.params['uploadId'] ?? '', identityId);
    const bytes = await sessions.assemble(session);
    // The same door as a single-request upload: same checks, same parsing, same audit entry.
    const created = await storeSource(req, workspace, session.filename, session.extension, session.mediaType, bytes, { kind: 'upload' });
    await sessions.remove(session);
    return json(201, toWireRecord(created));
  }

  async function cancelUpload(req: ApiRequest): Promise<ApiResponse> {
    const { sessions, identityId } = await uploadContext(req);
    await sessions.remove(await sessions.get(req.params['uploadId'] ?? '', identityId));
    return json(200, { cancelled: true });
  }

  router.post('/workspaces/:workspaceId/uploads', guarded(openUpload));
  router.get('/workspaces/:workspaceId/uploads/:uploadId', guarded(uploadStatus));
  router.put('/workspaces/:workspaceId/uploads/:uploadId', guarded(uploadChunk));
  router.post('/workspaces/:workspaceId/uploads/:uploadId/complete', guarded(completeUpload));
  router.delete('/workspaces/:workspaceId/uploads/:uploadId', guarded(cancelUpload));

  router.post('/workspaces/:workspaceId/sources', guarded(upload));
  router.post('/workspaces/:workspaceId/sources/import', guarded(importFromUrl));
  router.get('/workspaces/:workspaceId/sources', guarded(listSources));
  router.get('/workspaces/:workspaceId/source-versions', guarded(listSourceVersions));
  router.get('/workspaces/:workspaceId/sources/:sourceId', guarded(getSource));
  router.get('/workspaces/:workspaceId/sources/:sourceId/content', guarded(getSourceContent));
  router.add('DELETE', '/workspaces/:workspaceId/sources/:sourceId', guarded(deleteSource));
}

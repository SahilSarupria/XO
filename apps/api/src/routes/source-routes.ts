import { extname } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { SUPPORTED_EXTENSIONS, inferMediaType, type SourceRecord } from '../sources/source.js';

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

export function registerSourceRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  async function upload(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);

    const filename = req.query.get('filename');
    if (filename === null || filename.trim().length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'query parameter "filename" (the original filename) is required');
    }
    // A filename is metadata, never a path: reject anything that even
    // looks like it's trying to smuggle a directory component, and
    // normalize to its base name regardless, so nothing derived from it
    // (nothing IS, today — see the doc comment above — but this keeps
    // that guarantee true even if a future change starts using it) could
    // ever be interpreted as a path.
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"filename" must not contain path separators or ".."');
    }

    const extension = extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `unsupported file extension "${extension || '(none)'}" — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
    }

    const bytes = await req.rawBody();
    if (bytes.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body is empty; a non-empty file upload is required');
    }

    const mediaType = inferMediaType(extension, req.headers['content-type']);
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const created = await store.create(workspace.workspaceId, workspace.identityId, {
      originalFilename: filename,
      mediaType,
      extension,
      bytes: new Uint8Array(bytes),
    });
    if (!created.ok) throw created.error;

    return json(201, toWireRecord(created.value));
  }

  async function listSources(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const listed = await store.list();
    if (!listed.ok) throw listed.error;
    return json(200, { sources: listed.value.map(toWireRecord) });
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
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
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
  }

  async function deleteSource(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const deleted = await store.delete(sourceId);
    if (!deleted.ok) throw deleted.error;
    return { status: 204 };
  }

  router.post('/workspaces/:workspaceId/sources', guarded(upload));
  router.get('/workspaces/:workspaceId/sources', guarded(listSources));
  router.get('/workspaces/:workspaceId/sources/:sourceId', guarded(getSource));
  router.get('/workspaces/:workspaceId/sources/:sourceId/content', guarded(getSourceContent));
  router.add('DELETE', '/workspaces/:workspaceId/sources/:sourceId', guarded(deleteSource));
}

import { extname } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { callerIdentityId, requirePermission, requireOwnedWorkspace, workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { recordAudit } from '../audit/record.js';
import { DocxError, extractDocxText } from '../sources/docx-text.js';
import { safeFetch, type LookupFn, type TransportFn } from '../sources/safe-fetch.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { workspaceStateStore } from '../workspace/workspace-context.js';
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

/** Host + path only: a query string or fragment on a pasted link can carry tokens, so it is never stored or logged. */
export function safeOriginLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

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

export function registerSourceRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig, options: SourceRouteOptions = {}): void {
  const fetchDeps = options.fetchDeps ?? {};
  async function upload(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'upload source' });

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
      throw new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `unsupported file extension "${extension || '(none)'}" — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
      );
    }

    const bytes = await req.rawBody();
    if (bytes.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body is empty; a non-empty file upload is required');
    }

    const mediaType = inferMediaType(extension, req.headers['content-type']);
    const created = await storeSource(req, workspace, filename, extension, mediaType, new Uint8Array(bytes), { kind: 'upload' });
    return json(201, toWireRecord(created));
  }


  /**
   * The one place a source is persisted — shared by upload and URL import so both get the same checks, the same
   * ingest-time measurements and the same audit entry. `.docx` is parsed here once so a corrupt file is refused at the
   * door (400) instead of failing later inside a compile.
   */
  async function storeSource(
    req: ApiRequest,
    workspace: Parameters<typeof workspaceSourcesStore>[0],
    filename: string,
    extension: string,
    mediaType: string,
    bytes: Uint8Array,
    origin: NonNullable<SourceRecord['origin']>,
  ): Promise<SourceRecord> {
    let ingestNotes: readonly string[] | undefined;
    let stats: SourceRecord['stats'] | undefined;
    if (extension === '.docx') {
      try {
        const extracted = extractDocxText(bytes);
        ingestNotes = extracted.notes;
        stats = extracted.stats;
      } catch (cause) {
        if (cause instanceof DocxError) throw new XoError(ErrorCode.INVALID_ARGUMENT, `cannot read this .docx: ${cause.message}`);
        throw cause;
      }
    } else if (extension === '.csv') {
      const text = new TextDecoder().decode(bytes);
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      stats = { rows: Math.max(0, lines.length - 1) };
    } else if (extension === '.txt' || extension === '.md') {
      stats = { words: new TextDecoder().decode(bytes).split(/\s+/).filter(Boolean).length };
    }
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const created = await store.create(workspace.workspaceId, callerIdentityId(req), {
      originalFilename: filename,
      mediaType,
      extension,
      bytes,
      origin,
      ...(ingestNotes !== undefined ? { ingestNotes } : {}),
      ...(stats !== undefined ? { stats } : {}),
    });
    if (!created.ok) throw created.error;
    await recordAudit(req, workspace, dataConfig, {
      event: origin.kind === 'url' ? 'source.imported' : 'source.uploaded',
      result: 'succeeded',
      target: { kind: 'source', id: created.value.sourceId, label: filename },
      detail: { bytes: bytes.length, mediaType, ...(origin.kind === 'url' ? { from: safeOriginLabel(origin.url) } : {}) },
    });
    return created.value;
  }

  const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'text/html': '.html',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };

  async function importFromUrl(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'import source from link' });
    const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
    if (settings.airGapped) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this workspace is in air-gapped mode: importing from a link is disabled (upload the file instead)');
    }
    const bodyResult = await req.json<{ url?: unknown; filename?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const { url, filename: requestedName } = bodyResult.value ?? {};
    if (typeof url !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"url" (string) is required');
    if (requestedName !== undefined && typeof requestedName !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"filename", if present, must be a string');
    if (typeof requestedName === 'string' && (requestedName.includes('/') || requestedName.includes('\\') || requestedName.includes('..'))) {
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
      const fromType = contentType !== undefined ? MEDIA_TYPE_EXTENSIONS[contentType] : undefined;
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
    const created = await storeSource(req, workspace, name, extension, mediaType, fetched.bytes, { kind: 'url', url: safeOriginLabel(fetched.finalUrl) });
    return json(201, toWireRecord(created));
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
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'delete source', target: { kind: 'source', id: req.params['sourceId'] ?? '' } });
    const sourceId = req.params['sourceId'];
    if (sourceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing source id');
    const store = new FsSourceStore(workspaceSourcesStore(workspace, dataConfig));
    const deleted = await store.delete(sourceId);
    if (!deleted.ok) throw deleted.error;
    await recordAudit(req, workspace, dataConfig, { event: 'source.deleted', result: 'succeeded', target: { kind: 'source', id: sourceId } });
    return { status: 204 };
  }

  router.post('/workspaces/:workspaceId/sources', guarded(upload));
  router.post('/workspaces/:workspaceId/sources/import', guarded(importFromUrl));
  router.get('/workspaces/:workspaceId/sources', guarded(listSources));
  router.get('/workspaces/:workspaceId/sources/:sourceId', guarded(getSource));
  router.get('/workspaces/:workspaceId/sources/:sourceId/content', guarded(getSourceContent));
  router.add('DELETE', '/workspaces/:workspaceId/sources/:sourceId', guarded(deleteSource));
}

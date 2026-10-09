import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

/**
 * A single uploaded source document. Deliberately has NO compilation
 * status field — per the milestone brief, source registration/storage
 * is a separate concern from compilation, which doesn't exist yet.
 * `status` is included only as "stored" (the one state this milestone
 * can produce) so a later milestone can extend it (e.g. `'compiling'`,
 * `'compiled'`) as a genuinely additive change rather than inventing
 * the field under pressure once compilation lands.
 */
export interface SourceRecord {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly originalFilename: string;
  /** Normalized (lowercased, trimmed) media type — from the request's `Content-Type` header if present and well-formed, otherwise inferred from `extension` (see `inferMediaType`). Never trusted blindly for validation; see `extension`. */
  readonly mediaType: string;
  /** Lowercased, including the leading dot (e.g. `.pdf`) — derived from `originalFilename`, and the one field actually checked against `SUPPORTED_EXTENSIONS`. */
  readonly extension: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the exact received bytes. */
  readonly digestSha256: string;
  readonly createdAt: string;
  /**
   * The logical `BlobStore` key the content bytes live at within this
   * workspace's own sources store (e.g. `src_.../content`) — an opaque
   * label, not a filesystem path (see `workspace/workspace-context.ts`'s
   * `workspaceSourcesStore`, which is what actually resolves this key
   * to a real directory, server-side only). Safe to return to the
   * client for the same reason `WorkspaceRecord.storageKeyPrefix` is
   * (P0.1) — it means nothing without the server's own root.
   */
  readonly contentStorageKey: string;
  readonly status: 'stored';
}

export interface CreateSourceInput {
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
}

/**
 * The formats `@xo/compiler`'s default source-frontend registry
 * actually handles today (`packages/compiler/src/sources/default-registry.ts`),
 * mirrored from `apps/cli/src/commands/compiler/source-input.ts`'s own
 * `KNOWN_EXTENSIONS` — see that file's doc comment for the authoritative
 * mapping this list must stay in sync with. Duplicated here rather than
 * imported for the same reason `package-routes.ts#buildLocalStoreLookup`
 * duplicates a CLI helper: `apps/cli` declares only a `bin` in its
 * `package.json`, not an importable `exports` map, so nothing under
 * `apps/cli/src` can be imported from `apps/api`. Per the milestone
 * brief: "Do not invent new parsers or pretend unsupported formats
 * work" — DOCX and every other format not in this list is rejected at
 * upload time, not silently accepted and left to fail later at
 * compile time (which doesn't exist yet in this API).
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf', '.html', '.htm', '.json', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

const DEFAULT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Falls back to this extension's documented default when the caller's `Content-Type` is absent or not a plausible `type/subtype` shape — never trusts it blindly, but also never invents a mismatch when the caller simply didn't send one. */
export function inferMediaType(extension: string, contentTypeHeader: string | readonly string[] | undefined): string {
  const headerValue = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  const trimmed = (headerValue as string | undefined)?.split(';')[0]?.trim().toLowerCase();
  if (trimmed !== undefined && trimmed.length > 0 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(trimmed)) return trimmed;
  return DEFAULT_MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Same allowlist-before-storage posture as `isValidWorkspaceId` (`workspace/workspace.ts`) — defense-in-depth on top of, not instead of, `LocalFsBlobStore`'s own traversal guard. */
const SOURCE_ID_PATTERN = /^src_[0-9a-f]{32}$/;

export function isValidSourceId(value: string): boolean {
  return SOURCE_ID_PATTERN.test(value);
}

/**
 * The single authority for a workspace's own uploaded sources — scoped
 * entirely to whatever `BlobStore` it's constructed against (see
 * `workspace/workspace-context.ts#workspaceSourcesStore`, which roots
 * that `BlobStore` at `<dataRootDir>/<workspaceId>/sources`). Unlike
 * `WorkspaceStore` (P0.1), which has to filter one shared store by
 * `identityId` because every workspace's metadata lives together, a
 * `SourceStore` instance only ever sees one workspace's own sources by
 * construction — there is no cross-workspace query this interface could
 * even accidentally answer.
 */
export interface SourceStore {
  create(workspaceId: string, identityId: string, input: CreateSourceInput): Promise<Result<SourceRecord, XoError>>;
  get(sourceId: string): Promise<Result<SourceRecord, NotFoundError>>;
  getContent(sourceId: string): Promise<Result<Uint8Array, NotFoundError>>;
  list(): Promise<Result<readonly SourceRecord[], XoError>>;
  delete(sourceId: string): Promise<Result<void, NotFoundError>>;
}

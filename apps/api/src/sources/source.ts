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
  /** Where the bytes came from. Absent on records written before imports existed (those were all uploads). */
  readonly origin?:
    | { readonly kind: 'upload' }
    | { readonly kind: 'url'; readonly url: string }
    /** UW-3: opened from an email uploaded to this workspace — which email (its source and digest) and which MIME part. */
    | {
        readonly kind: 'email-attachment';
        readonly emailSourceId: string;
        readonly emailDigestSha256: string;
        readonly emailFilename: string;
        readonly part: string;
      };
  /** Things the server could not carry over when it read this file (e.g. .docx list numbering). Shown to the user; never silently dropped. */
  readonly ingestNotes?: readonly string[];
  /** Cheap, deterministic counts computed at ingest. Only fields that were actually measured are present. */
  readonly stats?: {
    readonly rows?: number;
    readonly words?: number;
    readonly paragraphs?: number;
    readonly tableRows?: number;
    /** UW-3: workbooks — sheets read and tables (record sets) found. */
    readonly sheets?: number;
    readonly tables?: number;
    /** UW-3: emails — attachments found (see `attachments` for which were opened as their own sources). */
    readonly attachments?: number;
  };
  /**
   * UW-3: emails — every attachment, in MIME order. One the server could open is stored as its own source (`sourceId`, origin
   * `email-attachment`) at upload, so it is read and compiled like any other file; one it could not is kept here with the reason.
   */
  readonly attachments?: readonly EmailAttachmentRecord[];
}

export interface EmailAttachmentRecord {
  readonly part: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  /** The source this attachment was stored as. */
  readonly sourceId?: string;
  /** Why it was not opened (unsupported format, unreadable, decoration, limit reached, ...). */
  readonly notOpened?: string;
}

export interface CreateSourceInput {
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
  readonly origin?: SourceRecord['origin'];
  readonly ingestNotes?: readonly string[];
  readonly stats?: SourceRecord['stats'];
  readonly attachments?: SourceRecord['attachments'];
  /** A source id minted in advance (`newSourceId()`), so related records can point at this one before it is written. */
  readonly sourceId?: string;
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
 * work" — every format not in this list is rejected at upload time,
 * not silently accepted and left to fail later at compile time.
 *
 * `.docx` is checked against this API's ZIP limits at upload (`sources/docx-text.ts`)
 * and then read by the compiler's own Word reader, both at upload (for the notes
 * recorded in `SourceRecord.ingestNotes`) and at compile time (UW-3c).
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.eml',
  '.html',
  '.htm',
  '.json',
  '.csv',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
]);

const DEFAULT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.eml': 'message/rfc822',
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

/** The extension a declared media type stands for, among the formats this server reads (link imports, unnamed email attachments). */
export const EXTENSION_FOR_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'message/rfc822': '.eml',
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

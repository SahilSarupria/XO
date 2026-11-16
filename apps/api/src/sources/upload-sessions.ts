import { createHash, randomBytes } from 'node:crypto';
import { ErrorCode, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';

/**
 * UW-3 — resumable uploads, for phones on unreliable networks. A client opens a session (file name, size, optionally the file's
 * SHA-256), sends the file in chunks at explicit offsets, and after a dropped connection asks for the offset the server has and carries
 * on from there. Completing the session hands the assembled bytes to the same `storeSource` as a single-request upload, so every check
 * (type, door-time parsing, limits) and the audit entry are identical.
 *
 * Every chunk is stored under its own offset, so a retried chunk overwrites itself (idempotent) and the store needs no append. The
 * session's record is written after the chunk, so a crash between the two leaves the offset where it was and the client re-sends that
 * chunk. Sessions belong to the identity that opened them and expire after `UPLOAD_SESSION_TTL_MS`.
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_OPEN_SESSIONS_PER_IDENTITY = 10;

export interface UploadSession {
  readonly uploadId: string;
  readonly identityId: string;
  readonly filename: string;
  readonly extension: string;
  readonly mediaType: string;
  readonly size: number;
  /** Lower-case hex SHA-256 the client declared for the whole file; checked on completion. */
  readonly sha256?: string;
  /** Bytes received so far; the next chunk must start here. */
  readonly offset: number;
  /** Offsets at which a chunk is stored, ascending. */
  readonly chunks: readonly number[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

const ID = /^upl_[0-9a-f]{32}$/;
const metaKey = (id: string) => `${id}/session.json`;
const chunkKey = (id: string, offset: number) => `${id}/chunks/${String(offset).padStart(12, '0')}.bin`;

export function isUploadId(value: string): boolean {
  return ID.test(value);
}

export class UploadSessionStore {
  constructor(
    private readonly store: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(input: {
    readonly identityId: string;
    readonly filename: string;
    readonly extension: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256?: string;
  }): Promise<UploadSession> {
    await this.sweepExpired();
    const mine = (await this.all()).filter((s) => s.identityId === input.identityId);
    if (mine.length >= MAX_OPEN_SESSIONS_PER_IDENTITY) {
      throw new XoError(
        ErrorCode.UPLOAD_SESSION_LIMIT,
        `you already have ${mine.length} unfinished uploads; finish or cancel one first (limit ${MAX_OPEN_SESSIONS_PER_IDENTITY})`,
      );
    }
    const at = this.now();
    const session: UploadSession = {
      uploadId: `upl_${randomBytes(16).toString('hex')}`,
      identityId: input.identityId,
      filename: input.filename,
      extension: input.extension,
      mediaType: input.mediaType,
      size: input.size,
      ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
      offset: 0,
      chunks: [],
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + UPLOAD_SESSION_TTL_MS).toISOString(),
    };
    await this.write(session);
    return session;
  }

  /** The caller's own, unexpired session; anything else is "not found" (no difference is revealed). */
  async get(uploadId: string, identityId: string): Promise<UploadSession> {
    if (!isUploadId(uploadId)) throw new XoError(ErrorCode.NOT_FOUND, 'no such upload');
    const raw = await this.store.get(metaKey(uploadId));
    if (!raw.ok) throw new XoError(ErrorCode.NOT_FOUND, 'no such upload');
    const session = JSON.parse(new TextDecoder().decode(raw.value)) as UploadSession;
    if (session.identityId !== identityId) throw new XoError(ErrorCode.NOT_FOUND, 'no such upload');
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      await this.remove(session);
      throw new XoError(ErrorCode.NOT_FOUND, 'this upload expired; start it again');
    }
    return session;
  }

  /** Stores one chunk at `offset`, which must be exactly where the session is. Returns the new offset. */
  async append(session: UploadSession, offset: number, bytes: Uint8Array): Promise<UploadSession> {
    if (offset !== session.offset) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `this upload continues at byte ${session.offset}, not ${offset}`, {
        context: { offset: session.offset },
      });
    }
    if (bytes.length === 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a chunk must not be empty');
    if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `a chunk may be at most ${MAX_UPLOAD_CHUNK_BYTES} bytes`);
    }
    if (offset + bytes.length > session.size) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `this chunk would take the upload past its declared size of ${session.size} bytes`);
    }
    const put = await this.store.put(chunkKey(session.uploadId, offset), bytes, { contentType: 'application/octet-stream' });
    if (!put.ok) throw put.error;
    const next: UploadSession = { ...session, offset: offset + bytes.length, chunks: [...session.chunks, offset] };
    await this.write(next);
    return next;
  }

  /** The assembled file, once every byte has arrived; verified against the declared SHA-256 when there is one. */
  async assemble(session: UploadSession): Promise<Uint8Array> {
    if (session.offset !== session.size) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the upload has ${session.offset} of ${session.size} bytes; send the rest first`, {
        context: { offset: session.offset },
      });
    }
    const parts: Uint8Array[] = [];
    let expected = 0;
    for (const offset of session.chunks) {
      if (offset !== expected) throw new XoError(ErrorCode.UNKNOWN, 'upload chunks are out of order');
      const got = await this.store.get(chunkKey(session.uploadId, offset));
      if (!got.ok) throw new XoError(ErrorCode.UNKNOWN, `upload chunk at byte ${offset} is missing; start the upload again`);
      parts.push(got.value);
      expected += got.value.length;
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== session.size) throw new XoError(ErrorCode.UNKNOWN, 'the assembled upload does not have its declared size');
    if (session.sha256 !== undefined) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== session.sha256) {
        await this.remove(session);
        throw new XoError(
          ErrorCode.UPLOAD_INTEGRITY_FAILED,
          `the received file's SHA-256 (${actual}) is not the one declared (${session.sha256}); the upload was discarded, start it again`,
        );
      }
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async remove(session: UploadSession): Promise<void> {
    for (const offset of session.chunks) await this.store.delete(chunkKey(session.uploadId, offset));
    await this.store.delete(metaKey(session.uploadId));
  }

  private async write(session: UploadSession): Promise<void> {
    const put = await this.store.put(metaKey(session.uploadId), JSON.stringify(session), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  private async all(): Promise<UploadSession[]> {
    const keys = await this.store.list('');
    if (!keys.ok) {
      if (keys.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return []; // no upload has been opened in this workspace yet
      throw keys.error;
    }
    const out: UploadSession[] = [];
    for (const key of keys.value) {
      if (!key.endsWith('/session.json')) continue;
      const raw = await this.store.get(key);
      if (raw.ok) out.push(JSON.parse(new TextDecoder().decode(raw.value)) as UploadSession);
    }
    return out;
  }

  private async sweepExpired(): Promise<void> {
    const now = this.now().getTime();
    for (const s of await this.all()) if (Date.parse(s.expiresAt) <= now) await this.remove(s);
  }
}

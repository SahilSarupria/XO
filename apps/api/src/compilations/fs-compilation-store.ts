import { randomUUID } from 'node:crypto';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import { verifyCompilationArtifact, type CompilationArtifact } from '@xo/pre-execution';
import {
  isValidCompilationId,
  type CapabilityProjection,
  type CompilationRecord,
  type CompilationStore,
  type CompilationFailureInput,
  type CompilationSuccessInput,
  type CreateCompilationInput,
} from './compilation.js';

function metadataKey(compilationId: string): string {
  return `${compilationId}/metadata.json`;
}

function resultKey(compilationId: string): string {
  return `${compilationId}/result.json`;
}

function artifactKey(compilationId: string): string {
  return `${compilationId}/artifact.json`;
}

function mintCompilationId(): string {
  return `cmp_${randomUUID().replace(/-/g, '')}`;
}

function decodeRecord(bytes: Uint8Array): CompilationRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as CompilationRecord;
  } catch {
    return undefined;
  }
}

interface StoredResult {
  readonly capabilities: readonly CapabilityProjection[];
  readonly discoveredCount: number;
  readonly resolvedCount: number;
  readonly graph: unknown;
}

/** Same shape as `FsWorkspaceStore`/`FsSourceStore` — one JSON metadata record per entity, plus here, one additional JSON result blob for a succeeded compilation. */
export class FsCompilationStore implements CompilationStore {
  constructor(private readonly store: BlobStore) {}

  async create(workspaceId: string, identityId: string, input: CreateCompilationInput): Promise<Result<CompilationRecord, XoError>> {
    let compilationId = mintCompilationId();
    let attempts = 0;
    while (await this.store.has(metadataKey(compilationId))) {
      if (++attempts > 5) return err(new XoError(ErrorCode.UNKNOWN, 'could not mint a unique compilation id'));
      compilationId = mintCompilationId();
    }

    const now = new Date().toISOString();
    const record: CompilationRecord = {
      compilationId,
      workspaceId,
      identityId,
      sourceId: input.sourceId,
      sourceDigestSha256: input.sourceDigestSha256,
      status: 'running',
      createdAt: now,
      startedAt: now,
    };

    const put = await this.store.put(metadataKey(compilationId), JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async markSucceeded(compilationId: string, input: CompilationSuccessInput): Promise<Result<CompilationRecord, XoError>> {
    const found = await this.get(compilationId);
    if (!found.ok) return err(found.error);

    const stored: StoredResult = {
      capabilities: input.capabilities,
      discoveredCount: input.discoveredCount,
      resolvedCount: input.resolvedCount,
      graph: input.graph,
    };
    const putResult = await this.store.put(resultKey(compilationId), JSON.stringify(stored), { contentType: 'application/json' });
    if (!putResult.ok) return err(putResult.error);
    if (input.artifact !== undefined) {
      const putArtifact = await this.store.put(artifactKey(compilationId), JSON.stringify(input.artifact), {
        contentType: 'application/json',
      });
      if (!putArtifact.ok) return err(putArtifact.error);
    }

    const record: CompilationRecord = {
      ...found.value,
      status: 'succeeded',
      completedAt: new Date().toISOString(),
      resultStorageKey: resultKey(compilationId),
      ...(input.sourceReport !== undefined ? { sourceReport: input.sourceReport } : {}),
      ...(input.artifact !== undefined ? { sourceSetId: input.artifact.sourceSet.sourceSetId, artifactDigest: input.artifact.digest } : {}),
    };
    const putMetadata = await this.store.put(metadataKey(compilationId), JSON.stringify(record), { contentType: 'application/json' });
    if (!putMetadata.ok) return err(putMetadata.error);
    return ok(record);
  }

  async markFailed(compilationId: string, input: CompilationFailureInput): Promise<Result<CompilationRecord, XoError>> {
    const found = await this.get(compilationId);
    if (!found.ok) return err(found.error);

    const record: CompilationRecord = {
      ...found.value,
      status: 'failed',
      completedAt: new Date().toISOString(),
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    };
    const putMetadata = await this.store.put(metadataKey(compilationId), JSON.stringify(record), { contentType: 'application/json' });
    if (!putMetadata.ok) return err(putMetadata.error);
    return ok(record);
  }

  async get(compilationId: string): Promise<Result<CompilationRecord, NotFoundError>> {
    if (!isValidCompilationId(compilationId)) return err(new NotFoundError(`compilation "${compilationId}"`));
    const raw = await this.store.get(metadataKey(compilationId));
    if (!raw.ok) return err(new NotFoundError(`compilation "${compilationId}"`));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError(`compilation "${compilationId}" (stored record is corrupt)`));
    return ok(record);
  }

  async list(): Promise<Result<readonly CompilationRecord[], XoError>> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listed.error);
    }
    const records: CompilationRecord[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('/metadata.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record !== undefined) records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ok(records);
  }

  async getCapabilities(compilationId: string): Promise<Result<readonly CapabilityProjection[], NotFoundError>> {
    const found = await this.get(compilationId);
    if (!found.ok) return err(found.error);
    if (found.value.status !== 'succeeded' || found.value.resultStorageKey === undefined) {
      return err(new NotFoundError(`compilation "${compilationId}" has no capability result (status: ${found.value.status})`));
    }
    const raw = await this.store.get(found.value.resultStorageKey);
    if (!raw.ok) return err(new NotFoundError(`compilation "${compilationId}" result`));
    try {
      const stored = JSON.parse(new TextDecoder().decode(raw.value)) as StoredResult;
      return ok(stored.capabilities);
    } catch {
      return err(new NotFoundError(`compilation "${compilationId}" result (stored result is corrupt)`));
    }
  }

  async getArtifact(compilationId: string): Promise<Result<CompilationArtifact, NotFoundError>> {
    const found = await this.get(compilationId);
    if (!found.ok) return err(found.error);
    if (found.value.status !== 'succeeded' || found.value.artifactDigest === undefined) {
      return err(new NotFoundError(`compilation "${compilationId}" has no compilation artifact (status: ${found.value.status})`));
    }
    const raw = await this.store.get(artifactKey(compilationId));
    if (!raw.ok) return err(new NotFoundError(`compilation "${compilationId}" artifact`));
    let artifact: CompilationArtifact;
    try {
      artifact = JSON.parse(new TextDecoder().decode(raw.value)) as CompilationArtifact;
    } catch {
      return err(new NotFoundError(`compilation "${compilationId}" artifact (stored artifact is corrupt)`));
    }
    // A stored artifact is checked against its own digest and the digest the record names before anyone reads it.
    const verified = verifyCompilationArtifact(artifact);
    if (!verified.ok || artifact.digest !== found.value.artifactDigest)
      return err(
        new NotFoundError(
          `compilation "${compilationId}" artifact (failed integrity check: ${verified.ok ? 'digest differs from the record' : verified.reason})`,
        ),
      );
    return ok(artifact);
  }

  async getCompiledGraph(compilationId: string): Promise<Result<unknown, NotFoundError>> {
    const found = await this.get(compilationId);
    if (!found.ok) return err(found.error);
    if (found.value.status !== 'succeeded' || found.value.resultStorageKey === undefined) {
      return err(new NotFoundError(`compilation "${compilationId}" has no compiled graph (status: ${found.value.status})`));
    }
    const raw = await this.store.get(found.value.resultStorageKey);
    if (!raw.ok) return err(new NotFoundError(`compilation "${compilationId}" result`));
    try {
      const stored = JSON.parse(new TextDecoder().decode(raw.value)) as StoredResult;
      return ok(stored.graph);
    } catch {
      return err(new NotFoundError(`compilation "${compilationId}" result (stored result is corrupt)`));
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';

/**
 * "Ask for more info" on a pending human task: a reviewer records a question, someone with `author` access answers it.
 * It never resolves, rejects or otherwise changes the human task itself — the task stays `pending` until a decision is
 * made through the normal resolve route. One JSON document per task, serialized per task within this process.
 */
export interface InfoRequest {
  readonly requestId: string;
  readonly question: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly answer?: string;
  readonly answeredBy?: string;
  readonly answeredAt?: string;
}

export const MAX_INFO_TEXT_LENGTH = 2000;
export const MAX_OPEN_INFO_REQUESTS = 10;

const key = (executionId: string) => `info-requests/${encodeURIComponent(executionId)}.json`;
const queues = new Map<string, Promise<unknown>>();

export class FsInfoRequestStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  async list(executionId: string): Promise<readonly InfoRequest[]> {
    const raw = await this.store.get(key(executionId));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw raw.error;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw.value)) as unknown;
      return Array.isArray(parsed) ? (parsed as InfoRequest[]) : [];
    } catch {
      return [];
    }
  }

  private locked<T>(executionId: string, work: () => Promise<T>): Promise<T> {
    const queueKey = `${this.workspaceId}/${executionId}`;
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(work);
    queues.set(
      queueKey,
      run.catch(() => undefined),
    );
    return run;
  }

  private async save(executionId: string, items: readonly InfoRequest[]): Promise<void> {
    const put = await this.store.put(key(executionId), JSON.stringify(items), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  /** Returns `undefined` when too many requests are already open (the caller maps that to a 409/412). */
  open(executionId: string, question: string, requestedBy: string, now: Date): Promise<InfoRequest | undefined> {
    return this.locked(executionId, async () => {
      const existing = await this.list(executionId);
      if (existing.filter((r) => r.answer === undefined).length >= MAX_OPEN_INFO_REQUESTS) return undefined;
      const request: InfoRequest = { requestId: `ir_${randomUUID().replace(/-/g, '')}`, question, requestedBy, requestedAt: now.toISOString() };
      await this.save(executionId, [...existing, request]);
      return request;
    });
  }

  /** `'not_found'` for an unknown request, `'already_answered'` when it already has an answer (an answer is never overwritten). */
  answer(executionId: string, requestId: string, answer: string, answeredBy: string, now: Date): Promise<InfoRequest | 'not_found' | 'already_answered'> {
    return this.locked(executionId, async () => {
      const existing = await this.list(executionId);
      const target = existing.find((r) => r.requestId === requestId);
      if (target === undefined) return 'not_found' as const;
      if (target.answer !== undefined) return 'already_answered' as const;
      const updated: InfoRequest = { ...target, answer, answeredBy, answeredAt: now.toISOString() };
      await this.save(executionId, existing.map((r) => (r.requestId === requestId ? updated : r)));
      return updated;
    });
  }
}

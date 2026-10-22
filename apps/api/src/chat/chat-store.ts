import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';

/**
 * Chat threads, private to the identity that created them. One JSON document per thread (messages inline), appends
 * serialized per thread. A thread is a plain conversation record — it carries no authority: nothing said in a chat
 * runs a capability, approves anything, or changes a workspace.
 */
export interface ChatMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: string;
  /** Assistant messages only: which provider/model actually produced this reply (after any fallback). */
  readonly model?: { readonly provider: string; readonly model: string };
  /** User messages only: installed XOs the user attached with "@name"; their capability descriptions were given to the model as reference data. */
  readonly attachedXos?: readonly string[];
}

export interface ChatThread {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly ownerIdentityId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
}

export const THREAD_ID_PATTERN = /^cht_[0-9a-f]{32}$/;
export const MAX_MESSAGES_PER_THREAD = 400;
export const MAX_THREADS_PER_IDENTITY = 200;

const key = (threadId: string) => `chats/${threadId}.json`;
const queues = new Map<string, Promise<unknown>>();

export class FsChatStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  private locked<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const k = `${this.workspaceId}/${threadId}`;
    const previous = queues.get(k) ?? Promise.resolve();
    const run = previous.then(work);
    queues.set(
      k,
      run.catch(() => undefined),
    );
    return run;
  }

  async get(threadId: string): Promise<ChatThread | undefined> {
    if (!THREAD_ID_PATTERN.test(threadId)) return undefined;
    const raw = await this.store.get(key(threadId));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as ChatThread;
    } catch {
      return undefined;
    }
  }

  private async save(thread: ChatThread): Promise<void> {
    const put = await this.store.put(key(thread.threadId), JSON.stringify(thread), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  /** Threads owned by `ownerIdentityId`, most recently updated first. */
  async listOwned(ownerIdentityId: string): Promise<readonly ChatThread[]> {
    const listed = await this.store.list('chats/');
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: ChatThread[] = [];
    for (const k of listed.value) {
      const m = /^chats\/(cht_[0-9a-f]{32})\.json$/.exec(k);
      if (m === null) continue;
      const t = await this.get(m[1] as string);
      if (t !== undefined && t.ownerIdentityId === ownerIdentityId) out.push(t);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async create(ownerIdentityId: string, title: string, now: Date): Promise<ChatThread> {
    const thread: ChatThread = {
      threadId: `cht_${randomUUID().replace(/-/g, '')}`,
      workspaceId: this.workspaceId,
      ownerIdentityId,
      title,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
    };
    await this.save(thread);
    return thread;
  }

  /** Appends messages atomically (all or none). Returns undefined when the thread does not exist or is full. */
  append(threadId: string, messages: readonly Omit<ChatMessage, 'messageId' | 'at'>[], now: Date, retitle?: string): Promise<ChatThread | undefined> {
    return this.locked(threadId, async () => {
      const current = await this.get(threadId);
      if (current === undefined) return undefined;
      if (current.messages.length + messages.length > MAX_MESSAGES_PER_THREAD) return undefined;
      const added: ChatMessage[] = messages.map((m) => ({ ...m, messageId: `msg_${randomUUID().replace(/-/g, '')}`, at: now.toISOString() }));
      const next: ChatThread = {
        ...current,
        ...(retitle !== undefined ? { title: retitle } : {}),
        updatedAt: now.toISOString(),
        messages: [...current.messages, ...added],
      };
      await this.save(next);
      return next;
    });
  }

  async delete(threadId: string): Promise<boolean> {
    if (!THREAD_ID_PATTERN.test(threadId)) return false;
    const del = await this.store.delete(key(threadId));
    return del.ok;
  }
}

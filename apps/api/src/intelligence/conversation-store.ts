import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import type { TurnResult } from '@xo/intelligence';

/**
 * Customer intelligence conversations, private to the identity that started them. Deliberately separate from the
 * Studio chat store (`chat/chat-store.ts`): the two experiences have different audiences, permissions and message
 * shapes, and must not be able to read each other's threads. Same mechanics (one JSON document per conversation,
 * appends serialized per conversation).
 */
export interface ConversationMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: string;
  /** Assistant messages: the full structured result (route, citations, confidence, proposal, notices, usage). */
  readonly result?: TurnResult;
}

export interface Conversation {
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly ownerIdentityId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ConversationMessage[];
}

export const CONVERSATION_ID_PATTERN = /^cnv_[0-9a-f]{32}$/;
export const MAX_MESSAGES_PER_CONVERSATION = 400;
export const MAX_CONVERSATIONS_PER_IDENTITY = 200;

const key = (id: string) => `conversations/${id}.json`;
const queues = new Map<string, Promise<unknown>>();

export class FsConversationStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  private locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const k = `${this.workspaceId}/${id}`;
    const run = (queues.get(k) ?? Promise.resolve()).then(work);
    queues.set(
      k,
      run.catch(() => undefined),
    );
    return run;
  }

  async get(id: string): Promise<Conversation | undefined> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return undefined;
    const raw = await this.store.get(key(id));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as Conversation;
    } catch {
      return undefined;
    }
  }

  private async save(c: Conversation): Promise<void> {
    const put = await this.store.put(key(c.conversationId), JSON.stringify(c), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  async listOwned(ownerIdentityId: string): Promise<readonly Conversation[]> {
    const listed = await this.store.list('conversations/');
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: Conversation[] = [];
    for (const k of listed.value) {
      const m = /^conversations\/(cnv_[0-9a-f]{32})\.json$/.exec(k);
      if (m === null) continue;
      const c = await this.get(m[1] as string);
      if (c !== undefined && c.ownerIdentityId === ownerIdentityId) out.push(c);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async create(ownerIdentityId: string, title: string, now: Date): Promise<Conversation> {
    const c: Conversation = {
      conversationId: `cnv_${randomUUID().replace(/-/g, '')}`,
      workspaceId: this.workspaceId,
      ownerIdentityId,
      title,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
    };
    await this.save(c);
    return c;
  }

  /** Appends atomically (all or none). Undefined when the conversation is missing or full. */
  append(
    id: string,
    messages: readonly Omit<ConversationMessage, 'messageId' | 'at'>[],
    now: Date,
    retitle?: string,
  ): Promise<Conversation | undefined> {
    return this.locked(id, async () => {
      const current = await this.get(id);
      if (current === undefined) return undefined;
      if (current.messages.length + messages.length > MAX_MESSAGES_PER_CONVERSATION) return undefined;
      const added: ConversationMessage[] = messages.map((m) => ({
        ...m,
        messageId: `msg_${randomUUID().replace(/-/g, '')}`,
        at: now.toISOString(),
      }));
      const next: Conversation = {
        ...current,
        ...(retitle !== undefined ? { title: retitle } : {}),
        updatedAt: now.toISOString(),
        messages: [...current.messages, ...added],
      };
      await this.save(next);
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return false;
    return (await this.store.delete(key(id))).ok;
  }
}

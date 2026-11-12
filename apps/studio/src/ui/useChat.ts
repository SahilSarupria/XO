import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachable } from '../domain/chat';
import type { ApiProblem } from '../platform/client';
import type { ChatSummary, ChatThreadFull } from '../platform/wire-studio';
import { useSession } from './session';

export interface ChatController {
  readonly list:
    | { readonly phase: 'loading' }
    | { readonly phase: 'ready'; readonly threads: readonly ChatSummary[] }
    | { readonly phase: 'error'; readonly problem: ApiProblem; readonly threads?: readonly ChatSummary[] };
  /** Installed XOs (names) that can be attached with @name. Empty until the install list has loaded. */
  readonly attachable: readonly Attachable[];
  readonly activeId: string | undefined;
  readonly thread: ChatThreadFull | undefined;
  readonly loadingThread: boolean;
  readonly sending: boolean;
  /** Why the last send / open / delete did not happen. Cleared by the next action. */
  readonly problem: ApiProblem | undefined;
  readonly select: (id: string) => void;
  readonly startNew: () => void;
  /** Resolves true when the message was saved and answered; false leaves the person's text for them to resend. */
  readonly send: (text: string, attach: readonly string[]) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
}

/**
 * Persisted chat for one workspace. Threads and messages live on the platform and are private to the caller; nothing
 * here is generated locally. The list is read when chat is first needed (`enabled`), not on every workspace view.
 */
export function useChat(workspaceId: string, enabled: boolean): ChatController {
  const { client } = useSession();
  const [list, setList] = useState<ChatController['list']>({ phase: 'loading' });
  const [activeId, setActiveId] = useState<string | undefined>();
  const [thread, setThread] = useState<ChatThreadFull | undefined>();
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [attachable, setAttachable] = useState<readonly Attachable[]>([]);
  const requested = useRef(0);

  const reload = useCallback(async () => {
    const r = await client.listChats(workspaceId);
    setList((prev) =>
      r.ok
        ? { phase: 'ready', threads: r.value }
        : {
            phase: 'error',
            problem: r.problem,
            ...(prev.phase !== 'loading' && prev.threads !== undefined ? { threads: prev.threads } : {}),
          },
    );
  }, [client, workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    void client.listInstalls(workspaceId).then((r) => {
      if (r.ok) setAttachable([...new Set(r.value.map((i) => i.name))].map((n) => ({ id: n, label: n })));
    });
  }, [enabled, reload, client, workspaceId]);

  const select = useCallback(
    (id: string) => {
      const mine = ++requested.current;
      setActiveId(id);
      setThread(undefined);
      setProblem(undefined);
      setLoadingThread(true);
      void client.getChat(workspaceId, id).then((r) => {
        if (mine !== requested.current) return;
        setLoadingThread(false);
        if (r.ok) setThread(r.value);
        else {
          setProblem(r.problem);
          if (r.problem.kind === 'not_found') {
            setActiveId(undefined);
            void reload();
          }
        }
      });
    },
    [client, workspaceId, reload],
  );

  const startNew = useCallback(() => {
    requested.current++;
    setActiveId(undefined);
    setThread(undefined);
    setProblem(undefined);
    setLoadingThread(false);
  }, []);

  const send = useCallback(
    async (text: string, attach: readonly string[]): Promise<boolean> => {
      setSending(true);
      setProblem(undefined);
      let id = activeId;
      let base = thread;
      if (id === undefined) {
        const c = await client.createChat(workspaceId);
        if (!c.ok) {
          setSending(false);
          setProblem(c.problem);
          return false;
        }
        id = c.value.threadId;
        base = { ...c.value, messages: [] };
        requested.current++;
        setActiveId(id);
        setThread(base);
      }
      const r = await client.sendChatMessage(workspaceId, id, text, attach);
      setSending(false);
      if (!r.ok) {
        setProblem(r.problem);
        if (r.problem.kind === 'not_found') {
          setActiveId(undefined);
          setThread(undefined);
        }
        void reload();
        return false;
      }
      setThread({
        threadId: r.value.threadId,
        title: r.value.title,
        updatedAt: r.value.assistantMessage.at,
        messageCount: (base?.messages.length ?? 0) + 2,
        messages: [...(base?.messages ?? []), r.value.userMessage, r.value.assistantMessage],
      });
      void reload();
      return true;
    },
    [client, workspaceId, activeId, thread, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      setProblem(undefined);
      const r = await client.deleteChat(workspaceId, id);
      if (!r.ok && r.problem.kind !== 'not_found') {
        setProblem(r.problem);
        return;
      }
      if (id === activeId) startNew();
      await reload();
    },
    [client, workspaceId, activeId, startNew, reload],
  );

  return { list, attachable, activeId, thread, loadingThread, sending, problem, select, startNew, send, remove };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachable } from '../domain/chat';
import type { ApiProblem } from '../platform/client';
import type { AskAnswer, AskContext } from '../platform/wire-ask';
import type { ChatSummary, ChatThreadFull } from '../platform/wire-studio';
import type { WorkflowSummaryView } from '../platform/wire-workflows';
import { useSession } from './session';

/** A question whose answer was not a chat reply (a card, not a saved message): shown under the conversation until dismissed. */
export interface AskedTurn {
  readonly id: string;
  readonly question: string;
  readonly answer: Exclude<AskAnswer, { kind: 'answer' }>;
}

export interface ChatController {
  /** S1-3b: answers that are cards (a document read, a prepared start, a place to go, a refusal). Cleared by New chat or opening a chat. */
  readonly asked: readonly AskedTurn[];
  readonly dismissAsked: (id: string) => void;
  /** Read a document through the Ask box: uploads it, then asks about it. Resolves true when it was read (or refused in words). */
  readonly analyse: (file: File) => Promise<boolean>;
  readonly list:
    | { readonly phase: 'loading' }
    | { readonly phase: 'ready'; readonly threads: readonly ChatSummary[] }
    | { readonly phase: 'error'; readonly problem: ApiProblem; readonly threads?: readonly ChatSummary[] };
  /** Installed XOs (names) that can be attached with @name. Empty until the install list has loaded. */
  readonly attachable: readonly Attachable[];
  readonly activeId: string | undefined;
  readonly thread: ChatThreadFull | undefined;
  readonly loadingThread: boolean;
  /** UW-2: the workflows created from the open conversation (empty when none, or when they cannot be read). */
  readonly workflows: readonly WorkflowSummaryView[];
  readonly sending: boolean;
  /** Why the last send / open / delete did not happen. Cleared by the next action. */
  readonly problem: ApiProblem | undefined;
  readonly select: (id: string) => void;
  readonly startNew: () => void;
  /** Resolves true when the message was saved and answered; false leaves the person's text for them to resend. */
  readonly send: (text: string, attach: readonly string[]) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
  /** Rate an answer; filed for review, changes no answer. Resolves true when it was recorded. */
  readonly rate: (messageId: string, rating: 'helpful' | 'unhelpful') => Promise<boolean>;
  /** UW-12a: open a conversation with what XO found in the connected folders. Resolves false (with `problem`) when it could not. */
  readonly startDiscovery: () => Promise<boolean>;
  /** UW-12a: confirm or reject a proposed role from a discovery message. */
  readonly decideRole: (connectionId: string, proposalId: string, decision: 'confirmed' | 'rejected') => Promise<boolean>;
}

/**
 * Persisted chat for one workspace. Threads and messages live on the platform and are private to the caller; nothing
 * here is generated locally. The list is read when chat is first needed (`enabled`), not on every workspace view.
 */
export function useChat(
  workspaceId: string,
  enabled: boolean,
  context: AskContext = { place: 'home' },
  onAnswer?: (answer: AskAnswer) => void,
): ChatController {
  // The latest screen context and callback, read when a question is sent, so the box is aware of where the person is NOW.
  const ctxRef = useRef(context);
  ctxRef.current = context;
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const [asked, setAsked] = useState<readonly AskedTurn[]>([]);
  const askedN = useRef(0);
  const { client } = useSession();
  const [list, setList] = useState<ChatController['list']>({ phase: 'loading' });
  const [activeId, setActiveId] = useState<string | undefined>();
  const [thread, setThread] = useState<ChatThreadFull | undefined>();
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [attachable, setAttachable] = useState<readonly Attachable[]>([]);
  const [workflows, setWorkflows] = useState<readonly WorkflowSummaryView[]>([]);
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
      setAsked([]);
      setWorkflows([]);
      setProblem(undefined);
      setLoadingThread(true);
      // Reopening a conversation shows the work it started. A failure here never hides the conversation itself.
      void client.listConversationWorkflows(workspaceId, id).then((w) => {
        if (mine === requested.current && w.ok) setWorkflows(w.value.workflows);
      });
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
    setAsked([]);
    setActiveId(undefined);
    setThread(undefined);
    setWorkflows([]);
    setProblem(undefined);
    setLoadingThread(false);
  }, []);

  const send = useCallback(
    async (text: string, attach: readonly string[]): Promise<boolean> => {
      setSending(true);
      setProblem(undefined);
      let id = activeId;
      if (id === undefined) {
        const c = await client.createChat(workspaceId);
        if (!c.ok) {
          setSending(false);
          setProblem(c.problem);
          return false;
        }
        id = c.value.threadId;
        requested.current++;
        setActiveId(id);
        setThread({ ...c.value, messages: [] });
      }
      // S1-3b: every question goes through the Ask route with where the person is. An answer that is a chat reply is saved in this
      // conversation by the platform; any other kind comes back as a card.
      const r = await client.ask(workspaceId, text, ctxRef.current, { conversationId: id, attach });
      if (!r.ok) {
        setSending(false);
        setProblem(r.problem);
        if (r.problem.kind === 'not_found') {
          setActiveId(undefined);
          setThread(undefined);
        }
        void reload();
        return false;
      }
      const answer = r.value;
      if (answer.kind === 'answer') {
        const t = await client.getChat(workspaceId, id);
        if (t.ok) setThread(t.value);
        else setProblem(t.problem);
      } else {
        const n = ++askedN.current;
        setAsked((a) => [...a, { id: `asked-${n}`, question: text, answer }]);
      }
      setSending(false);
      onAnswerRef.current?.(answer);
      void reload();
      return true;
    },
    [client, workspaceId, activeId, reload],
  );

  const analyse = useCallback(
    async (file: File): Promise<boolean> => {
      setSending(true);
      setProblem(undefined);
      const up = await client.uploadSource(workspaceId, file);
      if (!up.ok) {
        setSending(false);
        setProblem(up.problem);
        return false;
      }
      const r = await client.ask(workspaceId, '', { ...ctxRef.current, documentId: up.value.sourceId });
      setSending(false);
      if (!r.ok) {
        setProblem(r.problem);
        return false;
      }
      if (r.value.kind !== 'answer') {
        const answer = r.value;
        const n = ++askedN.current;
        setAsked((a) => [...a, { id: `asked-${n}`, question: `Read “${file.name}”`, answer }]);
      }
      onAnswerRef.current?.(r.value);
      return true;
    },
    [client, workspaceId],
  );

  const dismissAsked = useCallback((id: string) => setAsked((a) => a.filter((t) => t.id !== id)), []);

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

  const rate = useCallback(
    async (messageId: string, rating: 'helpful' | 'unhelpful'): Promise<boolean> => {
      if (activeId === undefined) return false;
      const r = await client.rateChatMessage(workspaceId, activeId, messageId, rating);
      if (!r.ok) setProblem(r.problem);
      return r.ok;
    },
    [client, workspaceId, activeId],
  );

  const startDiscovery = useCallback(async (): Promise<boolean> => {
    setProblem(undefined);
    const r = await client.startDiscoveryConversation(workspaceId);
    if (!r.ok) {
      setProblem(r.problem);
      return false;
    }
    requested.current++;
    setActiveId(r.value.threadId);
    setThread(r.value);
    setWorkflows([]);
    void reload();
    return true;
  }, [client, workspaceId, reload]);

  const decideRole = useCallback(
    async (connectionId: string, proposalId: string, decision: 'confirmed' | 'rejected'): Promise<boolean> => {
      const r = await client.decideSourceRole(workspaceId, connectionId, proposalId, decision);
      if (!r.ok) setProblem(r.problem);
      return r.ok;
    },
    [client, workspaceId],
  );

  return {
    asked,
    dismissAsked,
    analyse,
    list,
    attachable,
    activeId,
    thread,
    loadingThread,
    workflows,
    sending,
    problem,
    select,
    startNew,
    send,
    remove,
    rate,
    startDiscovery,
    decideRole,
  };
}

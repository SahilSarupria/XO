import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { describeProblem } from '../domain/review';
import { chatHint, groupByDay, matchXos, mentionQuery, type Attachable } from '../domain/chat';
import type { ApiProblem } from '../platform/client';
import type { ChatSummary, ChatThreadFull } from '../platform/wire-studio';
import { Button, ProblemNotice, Skeleton } from './primitives';
import type { ChatController } from './useChat';
import '../styles/chat.css';

/** The platform's refusal, verbatim, plus the next step for the chat refusals that have one. */
export function ChatProblem(props: { problem: ApiProblem; onOpenSettings: () => void }) {
  const hint = chatHint(props.problem);
  const shown = describeProblem(props.problem);
  const showRaw = props.problem.message !== '' && !`${shown.title} ${shown.body}`.includes(props.problem.message);
  return (
    <div className="chat-problem">
      <ProblemNotice problem={props.problem} />
      {showRaw ? <p className="small">Platform message: {props.problem.message}</p> : null}
      {hint === 'settings' ? (
        <p className="small">
          Chat needs a model with credentials, and it is unavailable in air-gapped mode. Check{' '}
          <button type="button" className="chat-link" onClick={props.onOpenSettings}>
            Settings → Models and runtime
          </button>
          .
        </p>
      ) : null}
      {hint === 'nothing_saved' ? (
        <p className="small">The model provider failed. Nothing was saved: your message was not stored, so you can send it again.</p>
      ) : null}
      {hint === 'gone' ? <p className="small">That conversation is no longer available to you.</p> : null}
    </div>
  );
}

/** The messages of one conversation, as a polite live log. Shared by the full Chat screen and the Ask XO drawer. */
export function ChatLog(props: { thread: ChatThreadFull | undefined; loading?: boolean; sending?: boolean }) {
  const { thread } = props;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [thread?.messages.length, props.sending]);
  return (
    <div className="chat-log" role="log" aria-live="polite" aria-label="Messages">
      {props.loading === true ? <Skeleton label="Loading conversation" rows={2} /> : null}
      {props.loading !== true && (thread === undefined || thread.messages.length === 0) ? (
        <p className="muted small">Ask a question. Your conversation is saved and private to you.</p>
      ) : (
        thread?.messages.map((m) => (
          <div key={m.messageId} className={m.role === 'user' ? 'chat-msg chat-you' : 'chat-msg chat-xo'}>
            <span className="visually-hidden">{m.role === 'user' ? 'You said: ' : 'XO replied: '}</span>
            <p>{m.content}</p>
            {m.attachedXos !== undefined && m.attachedXos.length > 0 ? (
              <p className="chat-attached">
                {m.attachedXos.map((a) => (
                  <span key={a} className="chat-tag">
                    @{a}
                  </span>
                ))}
              </p>
            ) : null}
            {m.role === 'assistant' && m.model !== undefined ? (
              <p className="muted small chat-model">
                Answered by {m.model.provider} · {m.model.model}
              </p>
            ) : null}
          </div>
        ))
      )}
      {props.sending === true ? (
        <p className="muted small" role="status">
          Waiting for the model…
        </p>
      ) : null}
      <div ref={end} />
    </div>
  );
}

/** The message box with @-mention picker for installed XOs. The text is kept until the platform has saved the message. */
export function ChatComposer(props: {
  xos: readonly Attachable[];
  onSend: (text: string, attached: readonly string[]) => Promise<boolean>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<readonly string[]>([]);
  const inputId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const query = mentionQuery(text);
  const suggestions = query === undefined ? [] : matchXos(props.xos, query).filter((x) => !attached.includes(x.label));
  useEffect(() => {
    if (props.autoFocus === true) box.current?.focus();
  }, [props.autoFocus]);

  function attach(label: string) {
    setAttached((a) => (a.includes(label) || a.length >= 5 ? a : [...a, label]));
    setText((t) => t.replace(/(^|\s)@[\w.-]*$/, '$1'));
    box.current?.focus();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === '' || props.disabled === true) return;
    if (await props.onSend(value, attached)) {
      setText('');
      setAttached([]);
    }
  }
  return (
    <form className="chat-composer" onSubmit={(e) => void submit(e)}>
      {attached.length > 0 ? (
        <p className="chat-attached">
          {attached.map((a) => (
            <button
              key={a}
              type="button"
              className="chat-tag"
              aria-label={`Remove ${a}`}
              onClick={() => setAttached((x) => x.filter((y) => y !== a))}
            >
              @{a} ×
            </button>
          ))}
        </p>
      ) : null}
      <label htmlFor={inputId} className="visually-hidden">
        Message
      </label>
      <textarea
        ref={box}
        id={inputId}
        rows={2}
        value={text}
        placeholder="Reply, or type @ to attach an installed XO…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {suggestions.length > 0 ? (
        <ul className="chat-suggest" role="listbox" aria-label="XOs you can attach">
          {suggestions.slice(0, 5).map((x) => (
            <li key={x.id} role="option" aria-selected="false">
              <button type="button" onClick={() => attach(x.label)}>
                @{x.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chat-foot">
        <button
          type="button"
          className="chat-pill"
          aria-disabled="true"
          title="Attaching files here is not available yet. Add documents under My XOs."
        >
          Attach
        </button>
        <button type="button" className="chat-pill" aria-disabled="true" title="Ask is the only mode">
          Ask ▾
        </button>
        <button type="button" className="chat-pill" aria-disabled="true" title="Choose the model under Settings → Models and runtime">
          Runtime ▾
        </button>
        <Button variant="primary" type="submit" className="chat-send" disabled={props.disabled === true}>
          {props.disabled === true ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}

/** One row of the thread list, with a two-step delete so a conversation is never removed by one stray click. */
export function ThreadRow(props: {
  thread: ChatSummary;
  current: boolean;
  onSelect: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li>
      <button
        type="button"
        className={props.className ?? 'chat-thread'}
        aria-current={props.current ? 'true' : undefined}
        onClick={props.onSelect}
      >
        {props.thread.title}
      </button>
      {confirming ? (
        <span className="chat-confirm">
          <button
            type="button"
            className="chat-link"
            onClick={() => {
              setConfirming(false);
              props.onDelete();
            }}
          >
            Confirm delete
          </button>
          <button type="button" className="chat-link" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="chat-link" aria-label={`Delete ${props.thread.title}`} onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </li>
  );
}

/** Thread list grouped by day. Shared by the full screen and the drawer. */
export function ThreadList(props: { chat: ChatController; rowClass?: string; groupClass?: string }) {
  const { list } = props.chat;
  const threads = list.phase === 'ready' ? list.threads : list.phase === 'error' ? (list.threads ?? []) : [];
  if (list.phase === 'loading') return <Skeleton label="Loading conversations" rows={2} />;
  return (
    <>
      {list.phase === 'error' ? <ProblemNotice problem={list.problem} /> : null}
      {threads.length === 0 && list.phase === 'ready' ? <p className="muted small chat-empty">No conversations yet.</p> : null}
      {groupByDay(threads).map((g) => (
        <div key={g.label}>
          <p className={props.groupClass ?? 'chat-group'}>{g.label}</p>
          <ul className="bare-list">
            {g.threads.map((t) => (
              <ThreadRow
                key={t.threadId}
                thread={t}
                current={t.threadId === props.chat.activeId}
                className={props.rowClass}
                onSelect={() => props.chat.select(t.threadId)}
                onDelete={() => void props.chat.remove(t.threadId)}
              />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Chat, expanded: saved conversations by day, the conversation, and the installed XOs you can attach. */
export function ChatScreen(props: { chat: ChatController; xos: readonly Attachable[]; onOpenSettings: () => void }) {
  const { chat } = props;
  return (
    <div className="chatscreen">
      <nav className="chat-threads" aria-label="Conversations">
        <Button variant="secondary" className="chat-new" onClick={chat.startNew}>
          + New chat
        </Button>
        <ThreadList chat={chat} />
      </nav>

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-head">
          <h2>{chat.thread?.title ?? 'New chat'}</h2>
          <span className="chat-chip">private to you</span>
        </header>
        {chat.problem !== undefined ? <ChatProblem problem={chat.problem} onOpenSettings={props.onOpenSettings} /> : null}
        <ChatLog thread={chat.thread} loading={chat.loadingThread} sending={chat.sending} />
        <ChatComposer xos={props.xos} onSend={chat.send} disabled={chat.sending} />
      </section>

      <aside className="chat-context" aria-label="Context">
        <h3 className="chat-label">Installed XOs</h3>
        {props.xos.length === 0 ? (
          <p className="muted small">None installed. Install one from the Library, then attach it with @.</p>
        ) : null}
        <ul className="bare-list">
          {props.xos.slice(0, 6).map((x) => (
            <li key={x.id} className="chat-xoitem">
              <span className="dot" aria-hidden="true" />
              {x.label}
            </li>
          ))}
        </ul>
        <p className="muted small">Conversations are saved on the platform and visible only to you.</p>
      </aside>
    </div>
  );
}

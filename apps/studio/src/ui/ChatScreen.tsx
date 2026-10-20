import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { matchXos, mentionQuery, type ChatThread } from '../domain/chat';
import type { StartTarget } from '../domain/start';
import type { XoItem } from '../domain/xo';
import { Badge, Button } from './primitives';
import '../styles/chat.css';

/**
 * Chat, expanded: thread list, conversation, context. Replies are scripted (see domain/chat) and say so; the trace panel
 * says it is not available because the platform does not report one. Threads live in this session only.
 */
export function ChatScreen(props: {
  threads: readonly ChatThread[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSend: (text: string, attached: readonly string[]) => void;
  xos: readonly XoItem[];
  goTo: (target: StartTarget) => void;
}) {
  const thread = props.threads.find((t) => t.id === props.activeId);
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<readonly string[]>([]);
  const inputId = useId();
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const query = mentionQuery(text);
  const suggestions = query === undefined ? [] : matchXos(props.xos, query).filter((x) => !attached.includes(x.label));

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [thread?.messages.length]);

  function attach(label: string) {
    setAttached((a) => (a.includes(label) ? a : [...a, label]));
    setText((t) => t.replace(/(^|\s)@[\w.-]*$/, '$1'));
    box.current?.focus(); // the picker closes; keep the person where they were typing
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === '') return;
    props.onSend(value, attached);
    setText('');
    setAttached([]);
  }

  const today = props.threads;
  return (
    <div className="chatscreen">
      <nav className="chat-threads" aria-label="Conversations">
        <Button variant="secondary" className="chat-new" onClick={props.onNew}>
          + New chat
        </Button>
        {today.length > 0 ? <p className="chat-group">This session</p> : <p className="muted small chat-empty">No conversations yet.</p>}
        <ul className="bare-list">
          {[...today].reverse().map((t) => (
            <li key={t.id}>
              <button type="button" className="chat-thread" aria-current={t.id === props.activeId ? 'true' : undefined} onClick={() => props.onSelect(t.id)}>
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-head">
          <h2>{thread?.title ?? 'New chat'}</h2>
          <span className="chat-chip">session memory</span>
          <Badge tone="accent">Preview</Badge>
        </header>
        <div className="chat-log" role="log" aria-live="polite" aria-label="Messages">
          {thread === undefined || thread.messages.length === 0 ? (
            <p className="muted small">Ask for something, or pick a suggestion. Replies in this preview are fixed and do not change anything.</p>
          ) : (
            thread.messages.map((m) => (
              <div key={m.id} className={m.from === 'you' ? 'chat-msg chat-you' : 'chat-msg chat-xo'}>
                <span className="visually-hidden">{m.from === 'you' ? 'You said: ' : 'XO preview reply: '}</span>
                <p>{m.text}</p>
                {m.attached !== undefined && m.attached.length > 0 ? (
                  <p className="chat-attached">
                    {m.attached.map((a) => (
                      <span key={a} className="chat-tag">
                        @{a}
                      </span>
                    ))}
                  </p>
                ) : null}
                {m.action !== undefined ? (
                  <button type="button" className="chat-link" onClick={() => props.goTo(m.action!.target)}>
                    {m.action.label} →
                  </button>
                ) : null}
              </div>
            ))
          )}
          <div ref={end} />
        </div>

        <form className="chat-composer" onSubmit={submit}>
          {attached.length > 0 ? (
            <p className="chat-attached">
              {attached.map((a) => (
                <button key={a} type="button" className="chat-tag" aria-label={`Remove ${a}`} onClick={() => setAttached((x) => x.filter((y) => y !== a))}>
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
            placeholder="Reply, or type @ to attach an XO…"
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
            <button type="button" className="chat-pill" aria-disabled="true" title="Attaching files here is not available yet. Add documents under My XOs.">
              Attach
            </button>
            <button type="button" className="chat-pill" aria-disabled="true" title="Ask is the only mode in this preview">
              Ask ▾
            </button>
            <button type="button" className="chat-pill" aria-disabled="true" title="Choosing a runtime is not available yet">
              Runtime ▾
            </button>
            <Button variant="primary" type="submit" className="chat-send">
              Send
            </Button>
          </div>
        </form>
      </section>

      <aside className="chat-context" aria-label="Context">
        <h3 className="chat-label">Loaded XOs</h3>
        {props.xos.length === 0 ? <p className="muted small">None yet. An XO is built from an analysed document.</p> : null}
        <ul className="bare-list">
          {props.xos.slice(0, 6).map((x) => (
            <li key={x.id} className="chat-xoitem">
              <span className="dot" aria-hidden="true" />
              {x.label}
            </li>
          ))}
        </ul>
        <h3 className="chat-label">Trace</h3>
        <p className="muted small">Not available yet. The platform does not report a trace for conversations.</p>
      </aside>
    </div>
  );
}

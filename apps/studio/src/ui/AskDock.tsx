import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { matchXos, mentionQuery, type ChatThread } from '../domain/chat';
import type { StartTarget } from '../domain/start';
import type { XoItem } from '../domain/xo';
import { Badge, Button } from './primitives';
import { ChatLog } from './ChatScreen';
import '../styles/drawer.css';

/** How long the panel's open and close animations run. The stylesheet uses the same number. */
export const DOCK_MS = 260;

export interface DockProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Changes whenever something (⌘J, the palette) asks for the cursor to go to the bar. */
  readonly focusTick: number;
  readonly thread: ChatThread | undefined;
  /** Every conversation of this session, oldest first, and the one being shown. */
  readonly threads: readonly ChatThread[];
  readonly onSelect: (id: string) => void;
  readonly xos: readonly XoItem[];
  readonly onSend: (text: string, attached: readonly string[]) => void;
  readonly onNew: () => void;
  readonly goTo: (target: StartTarget) => void;
}

type Phase = 'closed' | 'open' | 'closing';

/**
 * Ask XO: one bar, on every screen. Focusing or typing in it opens the conversation as a full-screen layer over the app.
 * The bar is the same element throughout: it glides from the top of the page to the bottom of the screen (a layout
 * animation that measures where it was and where it is now) while the history fades in above it. "Close chat" runs the
 * same movement backwards. Replies are fixed previews and the bar says so.
 */
export function AskDock(props: DockProps & { variant: 'home' | 'bar' | 'floating' }) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>('closed');
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const query = mentionQuery(text);
  const suggestions = query === undefined ? [] : matchXos(props.xos, query).filter((x) => !attached.includes(x.label));

  useEffect(() => {
    if (props.focusTick > 0) input.current?.focus();
  }, [props.focusTick]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (props.open) setPhase('open');
    else
      setPhase((p) => {
        if (p === 'closed') return p;
        timer.current = window.setTimeout(() => setPhase('closed'), DOCK_MS);
        return 'closing';
      });
    return () => window.clearTimeout(timer.current);
  }, [props.open]);

  useEffect(() => {
    if (phase !== 'open') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, props]);

  // Layout animation: remember where the bar was after the last render, and when it has moved, play it from there.
  const slot = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const slotHeight = useRef(0);
  const lastRect = useRef<DOMRect | undefined>(undefined);
  useLayoutEffect(() => {
    const el = form.current;
    const holder = slot.current;
    if (el === null || holder === null) return;
    if (!props.open) {
      holder.style.minHeight = '';
      slotHeight.current = holder.offsetHeight;
    } else holder.style.minHeight = `${slotHeight.current}px`;
    const next = el.getBoundingClientRect();
    const prev = lastRect.current;
    lastRect.current = next;
    if (prev === undefined || typeof el.animate !== 'function') return;
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(prev.width - next.width) < 1) return;
    el.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${prev.width / next.width}, 1)` },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      { duration: DOCK_MS * 1.4, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
  }, [props.open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === '') return;
    props.onSend(value, attached);
    setText('');
    setAttached([]);
    props.onOpenChange(true);
  }
  function close() {
    input.current?.blur();
    props.onOpenChange(false);
  }
  function attach(label: string) {
    setAttached((a) => (a.includes(label) ? a : [...a, label]));
    setText((t) => t.replace(/(^|\s)@[\w.-]*$/, '$1'));
    input.current?.focus();
  }

  return (
    <div className={`askdock askdock-v-${props.variant}`} data-phase={phase} data-open={props.open}>
      <div ref={slot} className="askdock-slot">
        <form ref={form} className={`cmdbar askdock-bar${props.open ? ' is-docked' : ''}`} onSubmit={submit}>
          <svg className="cmdbar-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 5h16v11H9l-5 4z" />
          </svg>
          <label htmlFor={inputId} className="visually-hidden">
            Ask XO
          </label>
          <input
            ref={input}
            id={inputId}
            className="cmdbar-input"
            value={text}
            autoComplete="off"
            placeholder={props.variant === 'home' && !props.open ? 'Ask XO, analyse a document, or start a process…' : 'Ask XO…'}
            aria-expanded={phase === 'open'}
            aria-controls="askdock-panel"
            onFocus={() => {
              if (!props.open) props.onOpenChange(true);
            }}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value !== '' && !props.open) props.onOpenChange(true);
            }}
          />
          <Badge tone="accent">Preview</Badge>
          {props.variant === 'home' && !props.open ? (
            <span className="cmdbar-pill" aria-disabled="true" title="Ask is the only mode in this preview">
              Ask ▾
            </span>
          ) : null}
          <kbd className="cmdbar-kbd">{props.variant === 'home' ? '⌘K' : '⌘J'}</kbd>
          <Button variant="secondary" type="submit">
            Send
          </Button>
        </form>
      </div>

      {phase !== 'closed' ? (
        <section id="askdock-panel" className="askdock-panel" role="dialog" aria-label="Ask XO conversation" data-phase={phase}>
          <nav className="askdock-side" aria-label="Conversations">
            <button type="button" className="askdock-back" onClick={close}>
              <span aria-hidden="true">← </span>Close chat
            </button>
            <button type="button" className="askdock-new" onClick={props.onNew}>
              <span aria-hidden="true">+ </span>New chat
            </button>
            {props.threads.length === 0 ? (
              <p className="askdock-note">No conversations yet.</p>
            ) : (
              <>
                <p className="askdock-group">This session</p>
                <ul className="bare-list askdock-threads">
                  {[...props.threads].reverse().map((t) => (
                    <li key={t.id}>
                      <button type="button" className="askdock-thread" aria-current={t.id === props.thread?.id ? 'true' : undefined} onClick={() => props.onSelect(t.id)}>
                        {t.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="askdock-note askdock-side-foot">Conversations are kept for this session only.</p>
          </nav>
          <div className="askdock-main">
            <header className="askdock-head">
              <h2>{props.thread?.title ?? 'New chat'}</h2>
              <span className="chat-chip">session memory</span>
              <Badge tone="accent">Preview</Badge>
            </header>
            <div className="askdock-body">
              {props.thread === undefined || props.thread.messages.length === 0 ? (
                <div className="askdock-welcome">
                  <h3>What can XO help with?</h3>
                  <p className="muted">Replies in this preview are fixed and do not change anything. Try one of these:</p>
                  <div className="askdock-starters">
                    {['What do I have in this workspace?', 'Show me the workflow graph', 'Create an XO from my documents'].map((q) => (
                      <button key={q} type="button" className="askdock-starter" onClick={() => props.onSend(q, [])}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <ChatLog thread={props.thread} goTo={props.goTo} />
              )}
            </div>
            <div className="askdock-foot">
              {attached.length > 0 ? (
                <p className="chat-attached askdock-attached">
                  {attached.map((a) => (
                    <button key={a} type="button" className="chat-tag" aria-label={`Remove ${a}`} onClick={() => setAttached((x) => x.filter((y) => y !== a))}>
                      @{a} ×
                    </button>
                  ))}
                </p>
              ) : null}
              {suggestions.length > 0 ? (
                <ul className="chat-suggest askdock-suggest" role="listbox" aria-label="XOs you can attach">
                  {suggestions.slice(0, 5).map((x) => (
                    <li key={x.id} role="option" aria-selected="false">
                      <button type="button" onClick={() => attach(x.label)}>
                        @{x.label}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <p className="askdock-legal">Preview: XO's replies here are fixed examples. Check anything that matters in the app.</p>
          </div>
        </section>
      ) : null}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { matchXos, mentionQuery, type ChatThread } from '../domain/chat';
import type { StartTarget } from '../domain/start';
import type { XoItem } from '../domain/xo';
import { Badge, Button } from './primitives';
import { ChatLog } from './ChatScreen';
import '../styles/drawer.css';

/** How long the panel's open, close and expand animations run. The stylesheet uses the same number. */
export const DOCK_MS = 260;

export interface DockProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Changes whenever something (⌘J, the palette) asks for the cursor to go to the bar. */
  readonly focusTick: number;
  readonly thread: ChatThread | undefined;
  readonly xos: readonly XoItem[];
  readonly onSend: (text: string, attached: readonly string[]) => void;
  readonly onNew: () => void;
  readonly onExpand: () => void;
  readonly goTo: (target: StartTarget) => void;
}

type Phase = 'closed' | 'open' | 'closing' | 'expanding';

/**
 * Ask XO: one bar, on every screen. Typing in it unfolds the conversation straight out of the bar, like a drawer opening
 * downwards; Enter sends. "Open full chat" grows the panel to the whole screen and continues in the Chat screen.
 * Replies are fixed previews and the bar says so. The panel is mounted only while it is on screen.
 */
export function AskDock(props: DockProps & { variant: 'home' | 'bar' | 'floating' }) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>('closed');
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const query = mentionQuery(text);
  const suggestions = query === undefined ? [] : matchXos(props.xos, query).filter((x) => !attached.includes(x.label));

  useEffect(() => {
    if (props.focusTick > 0) input.current?.focus();
  }, [props.focusTick]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (props.open) setPhase((p) => (p === 'expanding' ? p : 'open'));
    else
      setPhase((p) => {
        if (p === 'closed' || p === 'expanding') return p;
        timer.current = window.setTimeout(() => setPhase('closed'), DOCK_MS);
        return 'closing';
      });
    return () => window.clearTimeout(timer.current);
  }, [props.open]);

  useEffect(() => {
    if (phase === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (root.current?.contains(e.target as Node) !== true) props.onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [phase, props]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === '') return;
    props.onSend(value, attached);
    setText('');
    setAttached([]);
    props.onOpenChange(true);
  }
  function expand() {
    setPhase('expanding');
    timer.current = window.setTimeout(() => {
      props.onExpand();
      props.onOpenChange(false);
      setPhase('closed');
    }, DOCK_MS);
  }
  function attach(label: string) {
    setAttached((a) => (a.includes(label) ? a : [...a, label]));
    setText((t) => t.replace(/(^|\s)@[\w.-]*$/, '$1'));
    input.current?.focus();
  }

  return (
    <div ref={root} className={`askdock askdock-v-${props.variant}`} data-phase={phase}>
      <form className="cmdbar askdock-bar" onSubmit={submit}>
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
          placeholder={props.variant === 'home' ? 'Ask XO, analyse a document, or start a process…' : 'Ask XO…'}
          aria-expanded={phase === 'open' || phase === 'expanding'}
          aria-controls="askdock-panel"
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value !== '' && !props.open) props.onOpenChange(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && props.open) {
              e.stopPropagation();
              props.onOpenChange(false);
            }
          }}
        />
        <Badge tone="accent">Preview</Badge>
        {props.variant === 'home' ? (
          <span className="cmdbar-pill" aria-disabled="true" title="Ask is the only mode in this preview">
            Ask ▾
          </span>
        ) : null}
        <kbd className="cmdbar-kbd">{props.variant === 'home' ? '⌘K' : '⌘J'}</kbd>
        <Button variant="secondary" type="submit">
          Send
        </Button>
      </form>

      {phase !== 'closed' ? (
        <section id="askdock-panel" className="askdock-panel" aria-label="Ask XO conversation">
          <header className="askdock-head">
            <h2>{props.thread?.title ?? 'New chat'}</h2>
            <span className="chat-chip">session memory</span>
            <div className="askdock-actions">
              <button type="button" className="btn btn-quiet" onClick={props.onNew}>
                New chat
              </button>
              <button type="button" className="btn btn-quiet" onClick={expand}>
                Open full chat
              </button>
              <button type="button" className="btn btn-quiet" aria-label="Close Ask XO" onClick={() => props.onOpenChange(false)}>
                ✕
              </button>
            </div>
          </header>
          <ChatLog thread={props.thread} goTo={props.goTo} />
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
        </section>
      ) : null}
    </div>
  );
}

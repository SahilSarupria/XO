import { useEffect, useRef, useState } from 'react';
import type { ChatThread } from '../domain/chat';
import type { StartTarget } from '../domain/start';
import type { XoItem } from '../domain/xo';
import { Badge } from './primitives';
import { ChatComposer, ChatLog } from './ChatScreen';
import '../styles/drawer.css';

/** How long the drawer's open/close/expand animation runs. The stylesheet uses the same number. */
export const DRAWER_MS = 260;

type Phase = 'closed' | 'open' | 'closing' | 'expanding';

/**
 * Ask XO, available from every screen: a drawer that slides in from the right, keeps the person where they are, and can grow
 * into the full Chat screen. It shows the same conversation as Chat. Replies are the same fixed preview replies, and it says so.
 * It is mounted only while it is on screen.
 */
export function ChatDrawer(props: {
  open: boolean;
  onClose: () => void;
  onExpand: () => void;
  thread: ChatThread | undefined;
  xos: readonly XoItem[];
  onSend: (text: string, attached: readonly string[]) => void;
  onNew: () => void;
  goTo: (target: StartTarget) => void;
}) {
  const [phase, setPhase] = useState<Phase>('closed');
  const opener = useRef<Element | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (props.open) {
      setPhase((p) => {
        if (p === 'closed') opener.current = document.activeElement;
        return p === 'expanding' ? p : 'open';
      });
    } else {
      setPhase((p) => {
        if (p === 'closed' || p === 'expanding') return p;
        timer.current = window.setTimeout(() => {
          setPhase('closed');
          if (opener.current instanceof HTMLElement && document.contains(opener.current)) opener.current.focus();
        }, DRAWER_MS);
        return 'closing';
      });
    }
    return () => window.clearTimeout(timer.current);
  }, [props.open]);

  if (phase === 'closed') return null;
  const expand = () => {
    setPhase('expanding');
    timer.current = window.setTimeout(() => {
      props.onExpand();
      setPhase('closed');
    }, DRAWER_MS);
  };
  return (
    <aside
      className="drawer"
      data-phase={phase}
      role="dialog"
      aria-label="Ask XO"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
    >
      <header className="drawer-head">
        <h2>{props.thread?.title ?? 'Ask XO'}</h2>
        <Badge tone="accent">Preview</Badge>
        <div className="drawer-actions">
          <button type="button" className="btn btn-quiet" onClick={props.onNew}>
            New chat
          </button>
          <button type="button" className="btn btn-quiet" onClick={expand}>
            Open full chat
          </button>
          <button type="button" className="btn btn-quiet" aria-label="Close Ask XO" onClick={props.onClose}>
            ✕
          </button>
        </div>
      </header>
      <div className="drawer-body">
        <ChatLog thread={props.thread} goTo={props.goTo} />
        <ChatComposer xos={props.xos} onSend={props.onSend} autoFocus />
      </div>
    </aside>
  );
}

/** The always-present way in: a slim bar at the top of every page. It opens the drawer; it does not send anything itself. */
export function AskBar(props: { onOpen: () => void; floating?: boolean }) {
  return (
    <button type="button" className={props.floating === true ? 'askbar askbar-float' : 'askbar'} onClick={props.onOpen} aria-label="Ask XO" aria-haspopup="dialog">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M4 5h16v11H9l-5 4z" />
      </svg>
      <span className="askbar-text">Ask XO…</span>
      <kbd className="cmdbar-kbd">⌘J</kbd>
    </button>
  );
}

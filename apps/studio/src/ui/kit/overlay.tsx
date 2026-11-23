import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * S1-1 kit overlays. A sheet is a side panel on desktop and a full screen on a phone; a dialog is centred. Both are modal:
 * focus moves into them, stays inside while they are open, Escape closes them, and focus goes back to what opened them.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Not hidden, and not inside a closed <details> (whose own <summary> stays reachable). */
function reachable(el: HTMLElement): boolean {
  if (el.closest('[hidden]') !== null) return false;
  const closed = el.closest('details:not([open])');
  return closed === null || (el.tagName === 'SUMMARY' && el.parentElement === closed);
}

function useModal(open: boolean, onClose: () => void, panel: React.RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
    first?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || panel.current === null) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(reachable);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const a = items[0]!;
      const z = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === a || document.activeElement === panel.current)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, [open, panel]);
}

function Overlay(props: {
  kind: 'sheet' | 'dialog';
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  role?: 'dialog' | 'alertdialog';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useModal(props.open, props.onClose, panel);
  if (!props.open) return null;
  return createPortal(
    <div className={`k-overlay k-overlay-${props.kind}`}>
      <div className="k-scrim" onClick={props.onClose} aria-hidden="true" />
      <div
        ref={panel}
        className={`k-${props.kind}`}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description !== undefined ? descId : undefined}
        tabIndex={-1}
      >
        <div className="k-overlay-head">
          <h2 id={titleId} className="k-overlay-title">
            {props.title}
          </h2>
          <button type="button" className="k-icon-btn k-icon-btn-md" aria-label="Close" title="Close" onClick={props.onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {props.description !== undefined ? (
          <p id={descId} className="k-overlay-desc">
            {props.description}
          </p>
        ) : null}
        <div className="k-overlay-body">{props.children}</div>
        {props.footer !== undefined ? <div className="k-overlay-foot">{props.footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet(props: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return <Overlay kind="sheet" {...props} />;
}

export function Dialog(props: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** An alert dialog interrupts to ask about something serious; use it only for that. */
  alert?: boolean;
}) {
  const { alert, ...rest } = props;
  return <Overlay kind="dialog" role={alert === true ? 'alertdialog' : 'dialog'} {...rest} />;
}

/* ---- toasts ---- */

export interface ToastMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: 'positive' | 'info' | 'danger';
}
const ToastContext = createContext<((text: string, tone?: ToastMessage['tone']) => void) | undefined>(undefined);

/**
 * Brief confirmations ("Saved"). Announced politely and gone after a few seconds, so a toast is never the only place an
 * outcome is shown: the screen itself must show the new state too. Failures that need action belong on the screen, not here.
 */
export function ToastProvider(props: { children: ReactNode; durationMs?: number }) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const next = useRef(1);
  const duration = props.durationMs ?? 5000;
  const show = useCallback(
    (text: string, tone: ToastMessage['tone'] = 'positive') => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), duration);
    },
    [duration],
  );
  return (
    <ToastContext.Provider value={show}>
      {props.children}
      <div className="k-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <p key={t.id} className="k-toast" data-tone={t.tone}>
            {t.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: ToastMessage['tone']) => void {
  const show = useContext(ToastContext);
  if (show === undefined) throw new Error('useToast needs a <ToastProvider> above it.');
  return show;
}

import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * The application frame: a left panel (workspace, sections, account) and a content area on the right.
 * On narrow screens the panel becomes a drawer opened from a Menu button; it closes when a section is
 * chosen or Escape is pressed. Layout only — it holds no data and grants nothing.
 */
const COLLAPSE_KEY = 'xo.studio.sidebar';
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export type FrameLayout = 'standard' | 'rail' | 'bare';

export function AppChrome(props: {
  switcher?: ReactNode;
  nav?: ReactNode;
  account?: ReactNode;
  children: ReactNode;
  /** `rail`: a narrow icon rail (chat). `bare`: no side panel (workflow graph, executions). Default: the full panel. */
  layout?: FrameLayout;
  rail?: ReactNode;
}) {
  const layout = props.layout ?? 'standard';
  const [open, setOpen] = useState(false);
  /** Icons only, expanding while hovered or focused. A convenience kept for next time; the page works without storage. */
  const [collapsed, setCollapsed] = useState(readCollapsed);
  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? 'expanded' : 'collapsed');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (layout !== 'standard') {
    return (
      <div className="app" data-layout={layout}>
        {layout === 'rail' ? (
          <aside className="rail" aria-label="XO Studio">
            <span className="brand-mark" aria-hidden="true" />
            {props.rail}
          </aside>
        ) : null}
        <div className="content content-immersive">{props.children}</div>
      </div>
    );
  }

  return (
    <div className="app" data-collapsed={collapsed}>
      <div className="mobile-bar">
        <button type="button" className="menu-button" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((v) => !v)}>
          <Icon name="menu" />
          <span>Menu</span>
        </button>
        <p className="brand">
          <span className="brand-mark" aria-hidden="true" />
          XO Studio
        </p>
      </div>
      {open ? <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <aside
        id="sidebar"
        className="sidebar"
        data-open={open}
        aria-label="XO Studio"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.nav-item') !== null) setOpen(false);
        }}
      >
        <div className="sidebar-top">
          <p className="brand sidebar-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">XO Studio</span>
          </p>
          <button
            type="button"
            className="sb-toggle"
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Keep the sidebar expanded' : 'Collapse the sidebar to icons'}
            title={collapsed ? 'Keep the sidebar expanded' : 'Collapse to icons. It expands when you point at it.'}
            onClick={toggleCollapsed}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16v14H4zM9 5v14" />
            </svg>
          </button>
        </div>
        {props.switcher !== undefined ? <div className="sidebar-block">{props.switcher}</div> : null}
        {props.nav}
        {props.account !== undefined ? <div className="sidebar-foot">{props.account}</div> : null}
      </aside>
      <div className="content">{props.children}</div>
    </div>
  );
}

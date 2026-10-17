import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * The application frame: a left panel (workspace, sections, account) and a content area on the right.
 * On narrow screens the panel becomes a drawer opened from a Menu button; it closes when a section is
 * chosen or Escape is pressed. Layout only — it holds no data and grants nothing.
 */
export function AppChrome(props: { switcher?: ReactNode; nav?: ReactNode; account: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="app">
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
        <p className="brand sidebar-brand">
          <span className="brand-mark" aria-hidden="true" />
          XO Studio
        </p>
        {props.switcher !== undefined ? <div className="sidebar-block">{props.switcher}</div> : null}
        {props.nav}
        <div className="sidebar-foot">{props.account}</div>
      </aside>
      <div className="content">{props.children}</div>
    </div>
  );
}

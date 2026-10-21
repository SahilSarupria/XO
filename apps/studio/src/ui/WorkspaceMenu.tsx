import { useEffect, useRef, useState } from 'react';
import type { Mode } from './session';

export interface MenuWorkspace {
  readonly id: string;
  readonly name: string;
}

/**
 * The workspace card at the foot of the sidebar. It opens a menu with everything about "where and who": switch or add a
 * workspace, Settings, the detail level, and Sign out. Nothing here changes what the person is allowed to do.
 */
export function WorkspaceMenu(props: {
  name: string;
  workspaces: readonly MenuWorkspace[];
  activeId: string;
  mode: Mode;
  settingsCurrent: boolean;
  onSelectWorkspace: (id: string) => void;
  onManage: () => void;
  onNew: () => void;
  onSettings: () => void;
  onMode: (m: Mode) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const card = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const r = card.current?.getBoundingClientRect();
    if (r !== undefined) setPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) === true || card.current?.contains(t) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (focusCard = true) => {
    setOpen(false);
    if (focusCard) card.current?.focus();
  };
  const run = (fn: () => void) => () => {
    close(true);
    fn();
  };
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  return (
    <>
      <button
        ref={card}
        type="button"
        className="ws-card"
        aria-label="Workspace menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={props.settingsCurrent ? 'page' : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ws-initial" aria-hidden="true">
          {props.name.trim().charAt(0).toUpperCase() || 'W'}
        </span>
        <span className="ws-text">
          <span className="ws-name">{props.name}</span>
          <span className="ws-status">
            <span className="dot" aria-hidden="true" /> Connected{props.mode === 'builder' ? ' · Builder' : ''}
          </span>
        </span>
      </button>
      {open ? (
        <div ref={menu} className="ws-menu" role="menu" aria-label="Workspace menu" style={{ left: pos.left, bottom: pos.bottom }} onKeyDown={onKey}>
          <p className="ws-menu-label" aria-hidden="true">
            Workspaces
          </p>
          {props.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.id === props.activeId}
              className="ws-menu-item"
              onClick={run(() => props.onSelectWorkspace(w.id))}
            >
              <span className="ws-menu-tick" aria-hidden="true">
                {w.id === props.activeId ? '✓' : ''}
              </span>
              {w.name}
            </button>
          ))}
          <button type="button" role="menuitem" className="ws-menu-item" onClick={run(props.onNew)}>
            + New workspace
          </button>
          <button type="button" role="menuitem" className="ws-menu-item" onClick={run(props.onManage)}>
            All workspaces
          </button>
          <hr />
          <button type="button" role="menuitem" className="ws-menu-item" onClick={run(props.onSettings)}>
            Settings
          </button>
          <p className="ws-menu-label" aria-hidden="true">
            Detail level
          </p>
          {(['user', 'builder'] as const).map((m) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={props.mode === m} className="ws-menu-item" onClick={run(() => props.onMode(m))}>
              <span className="ws-menu-tick" aria-hidden="true">
                {props.mode === m ? '✓' : ''}
              </span>
              {m === 'user' ? 'User mode' : 'Builder mode'}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" className="ws-menu-item" onClick={run(props.onSignOut)}>
            Sign out
          </button>
        </div>
      ) : null}
    </>
  );
}

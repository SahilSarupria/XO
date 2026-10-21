import { useEffect, useRef, useState } from 'react';
import '../styles/palette.css';

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

/** Whether a keydown is the shortcut that opens the palette: ⌘K on macOS, Ctrl+K elsewhere. */
export const isPaletteShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean =>
  e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);

export function matchCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...commands] : commands.filter((c) => c.label.toLowerCase().includes(q));
}

/** A keyboard-first list of places to go and things to switch. It only runs what the app already offers. */
export function CommandPalette(props: { open: boolean; onClose: () => void; commands: readonly PaletteCommand[] }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const shown = matchCommands(props.commands, q);

  useEffect(() => {
    if (props.open) {
      opener.current = document.activeElement;
      setQ('');
      setActive(0);
      input.current?.focus();
    } else if (opener.current instanceof HTMLElement) opener.current.focus();
  }, [props.open]);

  if (!props.open) return null;
  const choose = (c: PaletteCommand | undefined) => {
    if (c === undefined) return;
    props.onClose();
    c.run();
  };
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[active] !== undefined ? `pal-${shown[active]!.id}` : undefined}
          aria-label="Type a command"
          placeholder="Go to…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') choose(shown[active]);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Commands" className="bare-list">
          {shown.map((c, i) => (
            <li key={c.id} id={`pal-${c.id}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(c)}>
              <span>{c.label}</span>
              {c.hint !== undefined ? <span className="muted small">{c.hint}</span> : null}
            </li>
          ))}
        </ul>
        {shown.length === 0 ? <p className="muted small palette-empty">No command matches “{q}”.</p> : null}
      </div>
    </div>
  );
}

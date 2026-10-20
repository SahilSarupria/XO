import { useId, useState } from 'react';
import type { StartTarget } from '../domain/start';
import { Badge, Button } from './primitives';

export interface HomeChip {
  readonly label: string;
  readonly target: StartTarget;
}

/**
 * The command bar at the top of Home. Sending a message opens the conversation screen with it as the first message.
 * Replies there are scripted and labelled a preview, so nothing is presented as AI output. The quick actions are built
 * from what this workspace actually holds.
 */
export function HomeCommandBar(props: { onAsk: (text: string) => void; chips: readonly HomeChip[]; onChip?: (target: StartTarget) => void; hint?: string }) {
  const [text, setText] = useState('');
  const inputId = useId();
  return (
    <div className="cmd-wrap">
      <form
        className="cmdbar"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (value === '') return;
          setText('');
          props.onAsk(value);
        }}
      >
        <svg className="cmdbar-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
        <label htmlFor={inputId} className="visually-hidden">
          Ask XO
        </label>
        <input
          id={inputId}
          className="cmdbar-input"
          value={text}
          autoComplete="off"
          placeholder="Ask XO, analyse a document, or start a process…"
          onChange={(e) => setText(e.target.value)}
        />
        <Badge tone="accent">Preview</Badge>
        <span className="cmdbar-pill" aria-disabled="true" title="Ask is the only mode in this preview">
          Ask ▾
        </span>
        {props.hint !== undefined ? <kbd className="cmdbar-kbd">{props.hint}</kbd> : null}
        <Button variant="secondary" type="submit">
          Send
        </Button>
      </form>
      <ul className="chips-row bare-list" aria-label="Quick actions">
        {props.chips.map((c) => (
          <li key={c.label}>
            <button type="button" className="chip" onClick={() => props.onChip?.(c.target)}>
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

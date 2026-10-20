import { useId, useRef, useState } from 'react';
import { scriptedReply, type ScriptedReply } from '../domain/home';
import type { StartTarget } from '../domain/start';
import { Badge, Button } from './primitives';

interface Message {
  readonly id: number;
  readonly from: 'you' | 'xo';
  readonly text: string;
  readonly action?: ScriptedReply['action'];
}

/**
 * The command bar at the top of Home. Focusing it expands the page into a conversation; Escape or Close returns to Home.
 * Replies are scripted for now (see scriptedReply) and are labelled as a preview so nothing is presented as AI output.
 */
export function HomeCommandBar(props: { open: boolean; onOpenChange: (open: boolean) => void; goTo: (target: StartTarget) => void }) {
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const next = useRef(1);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);

  function send() {
    const value = text.trim();
    if (value === '') return;
    const reply = scriptedReply(value);
    const id = next.current;
    next.current += 2;
    setMessages((m) => [...m, { id, from: 'you', text: value }, { id: id + 1, from: 'xo', text: reply.text, action: reply.action }]);
    setText('');
  }

  return (
    <div className="cmd-wrap" data-open={props.open}>
      <form
        className="cmdbar"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            props.onOpenChange(false);
            input.current?.blur();
          }
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">
          Ask XO
        </label>
        <input
          ref={input}
          id={inputId}
          className="cmdbar-input"
          value={text}
          autoComplete="off"
          placeholder="Ask XO, analyse a document, or start a process…"
          onFocus={() => props.onOpenChange(true)}
          onChange={(e) => setText(e.target.value)}
        />
        <Badge tone="accent">Preview</Badge>
        {props.open ? (
          <Button variant="quiet" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
        ) : null}
        <Button variant="secondary" type="submit">
          Send
        </Button>
      </form>
      {props.open ? (
        <section className="chat" aria-label="Conversation" aria-live="polite">
          {messages.length === 0 ? (
            <p className="muted small">Ask for something, or pick a suggestion.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={m.from === 'you' ? 'msg msg-you' : 'msg msg-xo'}>
                <p>{m.text}</p>
                {m.action ? (
                  <Button variant="secondary" onClick={() => props.goTo(m.action!.target)}>
                    {m.action.label}
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}

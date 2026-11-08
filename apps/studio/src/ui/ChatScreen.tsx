import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { describeProblem } from '../domain/review';
import { chatHint, groupByDay, matchXos, mentionQuery, type Attachable } from '../domain/chat';
import type { ApiProblem } from '../platform/client';
import type { ChatMessage, ChatSummary, ChatThreadFull, TurnRoute } from '../platform/wire-studio';
import { Button, ProblemNotice, Skeleton } from './primitives';
import type { ChatController } from './useChat';
import '../styles/chat.css';

/** The platform's refusal, verbatim, plus the next step for the chat refusals that have one. */
export function ChatProblem(props: { problem: ApiProblem; onOpenSettings: () => void }) {
  const hint = chatHint(props.problem);
  const shown = describeProblem(props.problem);
  const showRaw = props.problem.message !== '' && !`${shown.title} ${shown.body}`.includes(props.problem.message);
  return (
    <div className="chat-problem">
      <ProblemNotice problem={props.problem} />
      {showRaw ? <p className="small">Platform message: {props.problem.message}</p> : null}
      {hint === 'settings' ? (
        <p className="small">
          Chat needs a model with credentials, and it is unavailable in air-gapped mode. Check{' '}
          <button type="button" className="chat-link" onClick={props.onOpenSettings}>
            Settings → Models and runtime
          </button>
          .
        </p>
      ) : null}
      {hint === 'nothing_saved' ? (
        <p className="small">The model provider failed. Nothing was saved: your message was not stored, so you can send it again.</p>
      ) : null}
      {hint === 'gone' ? <p className="small">That conversation is no longer available to you.</p> : null}
    </div>
  );
}

const ROUTE_LABEL: Record<TurnRoute, string> = {
  ask: 'Ask',
  decide: 'Decide',
  do: 'Do',
  learn: 'Learn',
  converse: 'Chat',
  clarify: 'Question',
};
const CONFIDENCE_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', none: '' } as const;

type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

/** Splits plain model text into paragraphs and bullet lists. Text only: nothing here can inject markup. */
export function toBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]\s+)(.*)$/.exec(line);
    if (bullet !== null) {
      const last = out[out.length - 1];
      if (last?.kind === 'ul') last.items.push(bullet[1] as string);
      else out.push({ kind: 'ul', items: [bullet[1] as string] });
    } else if (line.trim() === '') {
      out.push({ kind: 'p', text: '' });
    } else {
      const last = out[out.length - 1];
      if (last?.kind === 'p' && last.text !== '') last.text += `\n${line.trim()}`;
      else out.push({ kind: 'p', text: line.trim() });
    }
  }
  return out.filter((b) => b.kind === 'ul' || b.text !== '');
}

/** **bold** and citation markers like [2] or [1, 3]; a marker becomes a button that opens that source. */
function Inline(props: { text: string; onCite?: (n: number) => void }) {
  const parts = props.text.split(/(\*\*[^*]+\*\*|\[\d+(?:,\s*\d+)*\])/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
        const cite = /^\[(\d+(?:,\s*\d+)*)\]$/.exec(part);
        if (cite === null) return part;
        return (
          <sup key={i} className="chat-cites">
            {(cite[1] as string).split(/,\s*/).map((n) => (
              <button key={n} type="button" className="chat-cite" aria-label={`Source ${n}`} onClick={() => props.onCite?.(Number(n))}>
                {n}
              </button>
            ))}
          </sup>
        );
      })}
    </>
  );
}

export function MessageText(props: { text: string; onCite?: (n: number) => void }) {
  return (
    <div className="chat-text">
      {toBlocks(props.text).map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inline text={it} {...(props.onCite !== undefined ? { onCite: props.onCite } : {})} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Inline text={b.text} {...(props.onCite !== undefined ? { onCite: props.onCite } : {})} />
          </p>
        ),
      )}
    </div>
  );
}

const CONFIDENCE_TONE = { high: 'good', medium: 'warn', low: 'bad', none: 'none' } as const;

/**
 * What an assistant answer rests on and how sure it is: how XO understood the message (ASK, DECIDE, DO or LEARN),
 * confidence, the sources it cited, anything that weakens it, a proposed action (never run from here), follow-up
 * questions, and a way to say whether it helped. Rendered from the platform's own result, never composed here.
 */
export function AnswerDetails(props: {
  message: ChatMessage;
  onRate?: (messageId: string, rating: 'helpful' | 'unhelpful') => Promise<boolean>;
  onFollowUp?: (text: string) => void;
  sourcesOpen?: boolean;
  onSourcesToggle?: (open: boolean) => void;
  idPrefix?: string;
}) {
  const r = props.message.result;
  const [rated, setRated] = useState<'helpful' | 'unhelpful' | 'failed' | undefined>();
  if (r === undefined) {
    // No structured result (e.g. an older message): still say which model wrote it.
    return props.message.model === undefined ? null : (
      <div className="chat-answer">
        <div className="chat-actions">
          <span className="chat-model" title="The model that wrote this answer">
            {props.message.model.provider} · {props.message.model.model}
          </span>
        </div>
      </div>
    );
  }
  const rate = async (rating: 'helpful' | 'unhelpful') => {
    if (props.onRate === undefined) return;
    setRated((await props.onRate(props.message.messageId, rating)) ? rating : 'failed');
  };
  // A notice that repeats the reply word for word adds nothing.
  const notices = r.notices.filter((n) => n.message.trim() !== props.message.content.trim());
  const unbacked = (r.route === 'ask' || r.route === 'decide') && !r.grounded && r.confidence !== 'none';
  const uniqueSources = [...new Set(r.citations.map((c) => c.sourceName))];
  return (
    <div className="chat-answer">
      {r.route !== 'converse' ? (
        <p className="chat-meta">
          <span className="chat-route" data-route={r.route}>
            {ROUTE_LABEL[r.route]}
          </span>
          {CONFIDENCE_LABEL[r.confidence] !== '' ? (
            <span className="chat-conf" data-tone={CONFIDENCE_TONE[r.confidence]}>
              {CONFIDENCE_LABEL[r.confidence]}
            </span>
          ) : null}
        </p>
      ) : null}
      {r.proposal !== undefined ? (
        <div className="chat-proposal" role="group" aria-label="Proposed action">
          <p>
            <strong>Proposed: {r.proposal.capabilityName}</strong> — not run. It needs approval first.
          </p>
          {r.proposal.inputs.length > 0 ? (
            <ul className="bare-list small">
              {r.proposal.inputs.map((i) => (
                <li key={i.name}>
                  {i.name}: {i.value}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {r.citations.length > 0 ? (
        <details
          className="chat-sources"
          open={props.sourcesOpen === true}
          onToggle={(e) => props.onSourcesToggle?.((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            <span className="chat-sources-title">
              {r.citations.length} source{r.citations.length === 1 ? '' : 's'}
            </span>
            <span className="chat-sources-names">{uniqueSources.join(' · ')}</span>
          </summary>
          <ol aria-label="Sources">
            {r.citations.map((c) => (
              <li key={c.index} value={c.index} id={`${props.idPrefix ?? 'src'}-${c.index}`}>
                <span className="chat-src-name">{c.sourceName}</span>
                {c.asOf !== undefined ? <span className="chat-src-date"> · as of {c.asOf.slice(0, 10)}</span> : null}
                <blockquote>{c.excerpt}</blockquote>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {unbacked ? <p className="chat-note">Not backed by any source — treat with caution.</p> : null}
      {notices.length > 0 ? (
        <ul className="chat-notes" aria-label="Things to know about this answer">
          {notices.map((n) => (
            <li key={n.code}>{n.message}</li>
          ))}
        </ul>
      ) : null}
      {props.onFollowUp !== undefined && r.followUps.length > 0 ? (
        <div className="chat-followups" role="group" aria-label="Suggested follow-ups">
          {r.followUps.map((f) => (
            <button key={f} type="button" className="chat-followup" onClick={() => props.onFollowUp?.(f)}>
              {f}
            </button>
          ))}
        </div>
      ) : null}
      <div className="chat-actions">
        {props.onRate !== undefined && r.route !== 'clarify' && r.route !== 'learn' ? (
          rated === 'helpful' || rated === 'unhelpful' ? (
            <span role="status">Thanks — recorded for review.</span>
          ) : (
            <>
              <button type="button" className="chat-act" onClick={() => void rate('helpful')}>
                Helpful
              </button>
              <button type="button" className="chat-act" onClick={() => void rate('unhelpful')}>
                Not helpful
              </button>
              {rated === 'failed' ? <span role="status"> Couldn't record that.</span> : null}
            </>
          )
        ) : null}
        {props.message.model !== undefined ? (
          <span className="chat-model" title="The model that wrote this answer">
            {props.message.model.provider} · {props.message.model.model}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One assistant reply: the text, with citation markers that open and scroll to the matching source. */
function AssistantMessage(props: {
  message: ChatMessage;
  onRate?: (messageId: string, rating: 'helpful' | 'unhelpful') => Promise<boolean>;
  onFollowUp?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const prefix = `src-${props.message.messageId}`;
  const cite = (n: number) => {
    setOpen(true);
    setTimeout(() => {
      const el = document.getElementById(`${prefix}-${n}`);
      el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      el?.setAttribute('data-flash', 'true');
      setTimeout(() => el?.removeAttribute('data-flash'), 1400);
    }, 30);
  };
  return (
    <>
      <MessageText text={props.message.content} onCite={cite} />
      <AnswerDetails
        message={props.message}
        sourcesOpen={open}
        onSourcesToggle={setOpen}
        idPrefix={prefix}
        {...(props.onRate !== undefined ? { onRate: props.onRate } : {})}
        {...(props.onFollowUp !== undefined ? { onFollowUp: props.onFollowUp } : {})}
      />
    </>
  );
}

/** The messages of one conversation, as a polite live log. Shared by the full Chat screen and the Ask XO drawer. */
export function ChatLog(props: {
  thread: ChatThreadFull | undefined;
  loading?: boolean;
  sending?: boolean;
  onRate?: (messageId: string, rating: 'helpful' | 'unhelpful') => Promise<boolean>;
  onFollowUp?: (text: string) => void;
}) {
  const { thread } = props;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [thread?.messages.length, props.sending]);
  return (
    <div className="chat-log" role="log" aria-live="polite" aria-label="Messages">
      {props.loading === true ? <Skeleton label="Loading conversation" rows={2} /> : null}
      {props.loading !== true && (thread === undefined || thread.messages.length === 0) ? (
        <p className="muted small">Ask a question. Your conversation is saved and private to you.</p>
      ) : (
        thread?.messages.map((m, i) => (
          <div key={m.messageId} className={m.role === 'user' ? 'chat-msg chat-you' : 'chat-msg chat-xo'}>
            <span className="visually-hidden">{m.role === 'user' ? 'You said: ' : 'XO replied: '}</span>
            {m.role === 'assistant' ? (
              <>
                <span className="chat-avatar" aria-hidden="true">
                  XO
                </span>
                <div className="chat-body">
                  <AssistantMessage
                    message={m}
                    {...(props.onRate !== undefined ? { onRate: props.onRate } : {})}
                    {...(props.onFollowUp !== undefined && i === (thread?.messages.length ?? 0) - 1
                      ? { onFollowUp: props.onFollowUp }
                      : {})}
                  />
                </div>
              </>
            ) : (
              <>
                <p>{m.content}</p>
                {m.attachedXos !== undefined && m.attachedXos.length > 0 ? (
                  <p className="chat-attached">
                    {m.attachedXos.map((a) => (
                      <span key={a} className="chat-tag">
                        @{a}
                      </span>
                    ))}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ))
      )}
      {props.sending === true ? (
        <div className="chat-msg chat-xo chat-thinking" role="status">
          <span className="chat-avatar" aria-hidden="true">
            XO
          </span>
          <div className="chat-body">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="visually-hidden">Waiting for the model…</span>
          </div>
        </div>
      ) : null}
      <div ref={end} className="chat-end" />
    </div>
  );
}

/** The message box with @-mention picker for installed XOs. The text is kept until the platform has saved the message. */
export function ChatComposer(props: {
  xos: readonly Attachable[];
  onSend: (text: string, attached: readonly string[]) => Promise<boolean>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<readonly string[]>([]);
  const inputId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const query = mentionQuery(text);
  const suggestions = query === undefined ? [] : matchXos(props.xos, query).filter((x) => !attached.includes(x.label));
  useEffect(() => {
    if (props.autoFocus === true) box.current?.focus();
  }, [props.autoFocus]);

  function attach(label: string) {
    setAttached((a) => (a.includes(label) || a.length >= 5 ? a : [...a, label]));
    setText((t) => t.replace(/(^|\s)@[\w.-]*$/, '$1'));
    box.current?.focus();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === '' || props.disabled === true) return;
    if (await props.onSend(value, attached)) {
      setText('');
      setAttached([]);
    }
  }
  return (
    <form className="chat-composer" onSubmit={(e) => void submit(e)}>
      {attached.length > 0 ? (
        <p className="chat-attached">
          {attached.map((a) => (
            <button
              key={a}
              type="button"
              className="chat-tag"
              aria-label={`Remove ${a}`}
              onClick={() => setAttached((x) => x.filter((y) => y !== a))}
            >
              @{a} ×
            </button>
          ))}
        </p>
      ) : null}
      <label htmlFor={inputId} className="visually-hidden">
        Message
      </label>
      <textarea
        ref={box}
        id={inputId}
        rows={2}
        value={text}
        placeholder="Ask, decide, request, or correct — or type @ to focus on an installed XO…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {suggestions.length > 0 ? (
        <ul className="chat-suggest" role="listbox" aria-label="XOs you can attach">
          {suggestions.slice(0, 5).map((x) => (
            <li key={x.id} role="option" aria-selected="false">
              <button type="button" onClick={() => attach(x.label)}>
                @{x.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chat-foot">
        <button
          type="button"
          className="chat-pill"
          aria-disabled="true"
          title="Attaching files here is not available yet. Add documents under My XOs."
        >
          Attach
        </button>
        <button
          type="button"
          className="chat-pill"
          aria-disabled="true"
          title="XO works out whether you are asking, deciding, doing or correcting — there is no mode to pick"
        >
          Auto ▾
        </button>
        <button type="button" className="chat-pill" aria-disabled="true" title="Choose the model under Settings → Models and runtime">
          Runtime ▾
        </button>
        <Button variant="primary" type="submit" className="chat-send" disabled={props.disabled === true}>
          {props.disabled === true ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}

/** One row of the thread list, with a two-step delete so a conversation is never removed by one stray click. */
export function ThreadRow(props: {
  thread: ChatSummary;
  current: boolean;
  onSelect: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="chat-row">
      <button
        type="button"
        className={props.className ?? 'chat-thread'}
        aria-current={props.current ? 'true' : undefined}
        onClick={props.onSelect}
      >
        {props.thread.title}
      </button>
      {confirming ? (
        <span className="chat-confirm">
          <button
            type="button"
            className="chat-link"
            onClick={() => {
              setConfirming(false);
              props.onDelete();
            }}
          >
            Confirm delete
          </button>
          <button type="button" className="chat-link" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="chat-rowdel" aria-label={`Delete ${props.thread.title}`} onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </li>
  );
}

/** Thread list grouped by day. Shared by the full screen and the drawer. */
export function ThreadList(props: { chat: ChatController; rowClass?: string; groupClass?: string }) {
  const { list } = props.chat;
  const threads = list.phase === 'ready' ? list.threads : list.phase === 'error' ? (list.threads ?? []) : [];
  if (list.phase === 'loading') return <Skeleton label="Loading conversations" rows={2} />;
  return (
    <>
      {list.phase === 'error' ? <ProblemNotice problem={list.problem} /> : null}
      {threads.length === 0 && list.phase === 'ready' ? <p className="muted small chat-empty">No conversations yet.</p> : null}
      {groupByDay(threads).map((g) => (
        <div key={g.label}>
          <p className={props.groupClass ?? 'chat-group'}>{g.label}</p>
          <ul className="bare-list">
            {g.threads.map((t) => (
              <ThreadRow
                key={t.threadId}
                thread={t}
                current={t.threadId === props.chat.activeId}
                className={props.rowClass}
                onSelect={() => props.chat.select(t.threadId)}
                onDelete={() => void props.chat.remove(t.threadId)}
              />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Chat, expanded: saved conversations by day, the conversation, and the installed XOs you can attach. */
export function ChatScreen(props: { chat: ChatController; xos: readonly Attachable[]; onOpenSettings: () => void }) {
  const { chat } = props;
  return (
    <div className="chatscreen">
      <nav className="chat-threads" aria-label="Conversations">
        <Button variant="secondary" className="chat-new" onClick={chat.startNew}>
          + New chat
        </Button>
        <ThreadList chat={chat} />
      </nav>

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-head">
          <h2>{chat.thread?.title ?? 'New chat'}</h2>
          <span className="chat-private">Private to you</span>
        </header>
        {chat.problem !== undefined ? <ChatProblem problem={chat.problem} onOpenSettings={props.onOpenSettings} /> : null}
        <ChatLog
          thread={chat.thread}
          loading={chat.loadingThread}
          sending={chat.sending}
          onRate={chat.rate}
          onFollowUp={(t) => void chat.send(t, [])}
        />
        <ChatComposer xos={props.xos} onSend={chat.send} disabled={chat.sending} />
      </section>

      <aside className="chat-context" aria-label="Context">
        <h3 className="chat-label">Installed XOs</h3>
        {props.xos.length === 0 ? (
          <p className="muted small">None installed. Install one from the Library, then attach it with @.</p>
        ) : null}
        <ul className="bare-list">
          {props.xos.slice(0, 6).map((x) => (
            <li key={x.id} className="chat-xoitem">
              <span className="dot" aria-hidden="true" />
              {x.label}
            </li>
          ))}
        </ul>
        <p className="muted small">Conversations are saved on the platform and visible only to you.</p>
      </aside>
    </div>
  );
}

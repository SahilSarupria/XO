import { useState } from 'react';
import type { ReviewItem, Statement } from '../platform/wire-knowledge';
import {
  KNOWLEDGE_TABS,
  RESOLVE_NOTE,
  REVIEWER_NEEDED,
  decisionKindLabel,
  evidencePanel,
  reviewKindLabel,
  sourcesLine,
  statusView,
  uncertaintyLine,
  type KnowledgeTab,
} from '../domain/knowledge';
import { Badge, Button, EmptyState, formatWhen, ProblemNotice, Section, Skeleton, useLoad } from './primitives';
import { useSession } from './session';
import '../styles/knowledge.css';

/**
 * Knowledge (C7.3): what XO has learned from the sources you connected, read-only. Everything comes from the C6 SDK through the Connect
 * routes; what you see is limited to what your own access allows, and the screen says so.
 */
export function KnowledgeSection() {
  const [tab, setTab] = useState<KnowledgeTab>('search');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [open, setOpen] = useState<Statement | undefined>(undefined);
  const { client } = useSession();
  const caps = useLoad(() => client.connectCapabilities(), []);
  const canReview = caps.state.phase === 'ready' && caps.state.value.reviewKnowledge;
  const [refresh, setRefresh] = useState(0);

  return (
    <Section title="Knowledge" lede="What XO has learned from your connected sources. You see only what your own access allows.">
      <div className="knowledge-tabs" role="tablist" aria-label="Knowledge views">
        {KNOWLEDGE_TABS.filter((t) => t.id !== 'history' || canReview).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'knowledge-tab is-current' : 'knowledge-tab'}
            onClick={() => {
              setTab(t.id);
              setOpen(undefined);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="knowledge-layout">
        <div className="knowledge-main">
          {tab === 'search' ? (
            <>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  setSubmitted(query.trim());
                  setOpen(undefined);
                }}
              >
                <input
                  className="input"
                  aria-label="Search knowledge"
                  placeholder="Search by name, id or word"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button variant="primary" type="submit" disabled={query.trim().length === 0}>
                  Search
                </Button>
              </form>
              <p className="muted small">
                Keyword search: XO finds items containing your words. It does not interpret questions. Results show only what you may see.
              </p>
              {submitted === '' ? (
                <EmptyState title="Search what XO knows">Type a name, an id such as a project key, or a word.</EmptyState>
              ) : (
                <Results
                  key={`q:${submitted}:${refresh}`}
                  mode={{ q: submitted }}
                  onOpen={setOpen}
                  canReview={canReview}
                  onDecided={() => setRefresh((n) => n + 1)}
                />
              )}
            </>
          ) : null}
          {tab === 'entities' ? (
            <Results
              key={`entities:${refresh}`}
              mode={{ select: 'entities' }}
              onOpen={setOpen}
              canReview={canReview}
              onDecided={() => setRefresh((n) => n + 1)}
            />
          ) : null}
          {tab === 'claims' ? (
            <Results
              key={`claims:${refresh}`}
              mode={{ select: 'claims' }}
              onOpen={setOpen}
              canReview={canReview}
              onDecided={() => setRefresh((n) => n + 1)}
            />
          ) : null}
          {tab === 'conflicts' ? (
            <Results
              key={`conflicts:${refresh}`}
              mode={{ select: 'conflicts' }}
              onOpen={setOpen}
              canReview={canReview}
              onDecided={() => setRefresh((n) => n + 1)}
            />
          ) : null}
          {tab === 'history' ? <DecisionHistory /> : null}
          {tab === 'review' ? <ReviewQueue onOpen={setOpen} /> : null}
        </div>
        {open !== undefined ? <EvidencePanelView statement={open} onClose={() => setOpen(undefined)} /> : null}
      </div>
    </Section>
  );
}

type Mode = { readonly q: string } | { readonly select: 'entities' | 'relationships' | 'claims' | 'conflicts' | 'documents' };

function Results(props: { mode: Mode; onOpen: (s: Statement) => void; canReview?: boolean; onDecided?: () => void }) {
  const { client } = useSession();
  const load = useLoad(() => ('q' in props.mode ? client.knowledgeSearch(props.mode.q) : client.knowledgeSelect(props.mode.select)), []);
  if (load.state.phase === 'loading') return <Skeleton label="Loading knowledge" rows={3} />;
  if (load.state.phase === 'error') return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  const { data, uncertainty } = load.state.value;
  if (data.statements.length === 0)
    return 'q' in props.mode ? (
      <EmptyState title={`Nothing matched "${props.mode.q}"`}>
        Try fewer words, or check that a source is connected and has been read. Something missing here is not proof nothing is known.
      </EmptyState>
    ) : props.mode.select === 'conflicts' ? (
      <EmptyState title="No conflicting information found">Nothing needs a decision right now.</EmptyState>
    ) : (
      <EmptyState title="No knowledge yet">
        XO keeps what it reads, but only structured organizational records become knowledge today. Read a source from Connect.
      </EmptyState>
    );
  return (
    <>
      <p className="muted small">{uncertaintyLine(uncertainty)}</p>
      <ul className="knowledge-list">
        {data.statements.map((s) => (
          <StatementCard
            key={s.ref}
            statement={s}
            canReview={props.canReview === true}
            onDecided={props.onDecided ?? (() => undefined)}
            onOpen={() => props.onOpen(s)}
          />
        ))}
      </ul>
      {data.truncated ? <p className="notice notice-warning">Showing the first results. Narrow your search to see the rest.</p> : null}
    </>
  );
}

function StatementCard(props: { statement: Statement; onOpen: () => void; canReview: boolean; onDecided: () => void }) {
  const v = statusView(props.statement);
  const [deciding, setDeciding] = useState(false);
  const c = props.statement.conflict;
  return (
    <li className={`card knowledge-card knowledge-${v.tone}`}>
      <div>
        <strong>{props.statement.text}</strong>
        <p className="muted small">{v.explanation}</p>
        {props.statement.validity !== undefined ? (
          <p className="muted small">Since {formatWhen(props.statement.validity.validFrom)}</p>
        ) : null}
      </div>
      <div className="knowledge-card-end">
        <Badge tone={v.tone}>{v.label}</Badge>
        <span className="muted small">{sourcesLine(props.statement)}</span>
        <Button onClick={props.onOpen}>Evidence</Button>
        {c !== undefined && c.state === 'open' && props.canReview ? (
          <Button variant="primary" onClick={() => setDeciding(true)}>
            Decide
          </Button>
        ) : null}
      </div>
      {c !== undefined && c.state === 'open' && !props.canReview ? (
        <p className="muted small knowledge-row-note">A reviewer needs to decide. {REVIEWER_NEEDED}</p>
      ) : null}
      {c !== undefined && c.state === 'resolved' ? (
        <p className="muted small knowledge-row-note">A reviewer decided this. Both values and their sources are kept.</p>
      ) : null}
      {deciding && c !== undefined ? (
        <div className="knowledge-row-note">
          <Decide
            conflict={c}
            onCancel={() => setDeciding(false)}
            onDone={() => {
              setDeciding(false);
              props.onDecided();
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

function ReviewQueue(props: { onOpen: (s: Statement) => void }) {
  const { client } = useSession();
  const load = useLoad(() => client.knowledgeReview(), []);
  if (load.state.phase === 'loading') return <Skeleton label="Loading what needs review" rows={3} />;
  if (load.state.phase === 'error') return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  const items: readonly ReviewItem[] = load.state.value.data.items;
  if (items.length === 0)
    return <EmptyState title="Nothing needs review">No conflicts, single-source guesses or possible matches right now.</EmptyState>;
  return (
    <>
      <p className="muted small">A reviewer needs to decide these. Deciding is not available here yet.</p>
      <ul className="knowledge-list">
        {items.map((it) => (
          <li key={it.ref} className="card knowledge-card knowledge-warning">
            <div>
              <strong>{it.summary}</strong>
              <p className="muted small">{statusView(it.statement).explanation}</p>
            </div>
            <div className="knowledge-card-end">
              <Badge tone="warning">{reviewKindLabel(it.kind)}</Badge>
              <Button onClick={() => props.onOpen(it.statement)}>Evidence</Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function EvidencePanelView(props: { statement: Statement; onClose: () => void }) {
  const p = evidencePanel(props.statement);
  return (
    <aside className="card knowledge-evidence" aria-label="Evidence">
      <div className="row">
        <h3>Evidence</h3>
        <Button variant="quiet" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <p>
        <strong>{props.statement.text}</strong>
      </p>
      <h4>What backs this</h4>
      <p>{p.backing}</p>
      <ul className="knowledge-evidence-items">
        {p.items.map((i) => (
          <li key={i.key}>
            <div>{i.source}</div>
            <div className="muted small">Observed {formatWhen(i.observed)}</div>
            <code>{i.hash}</code>
          </li>
        ))}
      </ul>
      <h4>How sure is XO?</h4>
      <p>{p.howSure}</p>
      <h4>If a source is removed</h4>
      <p>{p.ifRemoved}</p>
      <p className="muted small">{p.visibility}</p>
    </aside>
  );
}

function Decide(props: { conflict: NonNullable<Statement['conflict']>; onDone: () => void; onCancel: () => void }) {
  const { client } = useSession();
  const [pick, setPick] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Parameters<typeof ProblemNotice>[0]['problem'] | undefined>(undefined);
  const decide = async (): Promise<void> => {
    if (pick === undefined) return;
    setBusy(true);
    setProblem(undefined);
    const r = await client.knowledgeResolveConflict(props.conflict.id, props.conflict.values[pick] as string | number | boolean);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    props.onDone();
  };
  return (
    <div className="notice" role="group" aria-label="Decide this conflict">
      <strong>Which value is right?</strong>
      {props.conflict.values.map((v, i) => (
        <label key={String(v)}>
          <input type="radio" name="winner" checked={pick === i} onChange={() => setPick(i)} /> {String(v)}
        </label>
      ))}
      <p className="muted small">{RESOLVE_NOTE}</p>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button variant="primary" pending={busy} disabled={pick === undefined} onClick={() => void decide()}>
          Record decision
        </Button>
      </div>
    </div>
  );
}

function DecisionHistory() {
  const { client } = useSession();
  const load = useLoad(() => client.knowledgeDecisions(), []);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Parameters<typeof ProblemNotice>[0]['problem'] | undefined>(undefined);
  if (load.state.phase === 'loading') return <Skeleton label="Loading review history" rows={2} />;
  if (load.state.phase === 'error') return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  const undo = async (id: string): Promise<void> => {
    setBusy(id);
    setProblem(undefined);
    const r = await client.knowledgeRevokeDecision(id);
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    load.reload();
  };
  if (load.state.value.length === 0)
    return <EmptyState title="No decisions yet">Decisions made by reviewers appear here, with who decided and when.</EmptyState>;
  return (
    <>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <ul className="knowledge-list">
        {load.state.value.map((d) => (
          <li key={d.id} className="card knowledge-card">
            <div>
              <strong>{decisionKindLabel(d.kind)}</strong>
              <p className="muted small">
                By {d.principalId} · {formatWhen(d.decidedAt)}
              </p>
            </div>
            <Button pending={busy === d.id} onClick={() => void undo(d.id)}>
              Undo decision
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

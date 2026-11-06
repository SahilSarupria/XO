import { useState } from 'react';
import type { ReviewItem, Statement } from '../platform/wire-knowledge';
import {
  KNOWLEDGE_TABS,
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

  return (
    <Section title="Knowledge" lede="What XO has learned from your connected sources. You see only what your own access allows.">
      <div className="knowledge-tabs" role="tablist" aria-label="Knowledge views">
        {KNOWLEDGE_TABS.map((t) => (
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
                <Results key={`q:${submitted}`} mode={{ q: submitted }} onOpen={setOpen} />
              )}
            </>
          ) : null}
          {tab === 'entities' ? <Results key="entities" mode={{ select: 'entities' }} onOpen={setOpen} /> : null}
          {tab === 'claims' ? <Results key="claims" mode={{ select: 'claims' }} onOpen={setOpen} /> : null}
          {tab === 'conflicts' ? <Results key="conflicts" mode={{ select: 'conflicts' }} onOpen={setOpen} /> : null}
          {tab === 'review' ? <ReviewQueue onOpen={setOpen} /> : null}
        </div>
        {open !== undefined ? <EvidencePanelView statement={open} onClose={() => setOpen(undefined)} /> : null}
      </div>
    </Section>
  );
}

type Mode = { readonly q: string } | { readonly select: 'entities' | 'relationships' | 'claims' | 'conflicts' | 'documents' };

function Results(props: { mode: Mode; onOpen: (s: Statement) => void }) {
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
          <StatementCard key={s.ref} statement={s} onOpen={() => props.onOpen(s)} />
        ))}
      </ul>
      {data.truncated ? <p className="notice notice-warning">Showing the first results. Narrow your search to see the rest.</p> : null}
    </>
  );
}

function StatementCard(props: { statement: Statement; onOpen: () => void }) {
  const v = statusView(props.statement);
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
      </div>
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

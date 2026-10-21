import { useMemo, useState } from 'react';
import type { Result } from '../platform/client';
import type { RegistryPackage, WorkflowRun } from '../platform/wire';
import type { StartTarget } from '../domain/start';
import { shortDid } from '../domain/xo';
import { Badge, Button, formatWhen, ProblemNotice, Section } from './primitives';
import { runTitle } from './RunCard';
import { useSession, type Mode } from './session';

const SAMPLE = [
  {
    name: 'burglary-policy',
    by: 'Sample publisher',
    text: 'Checks burglary claims against policy clauses and flags exclusions.',
    tag: 'Insurance',
  },
  {
    name: 'corp-contract-lawyer',
    by: 'Sample publisher',
    text: 'Reviews commercial contracts, flags risky clauses, suggests redlines.',
    tag: 'Legal',
  },
  {
    name: 'tax-consultant',
    by: 'Sample publisher',
    text: 'Answers GST and income-tax questions with citations to the source section.',
    tag: 'Finance',
  },
  { name: 'gdpr-expert', by: 'Sample publisher', text: 'Checks data-processing clauses and vendor terms for GDPR gaps.', tag: 'Legal' },
  { name: 'renewal-assistant', by: 'Sample publisher', text: 'Drafts renewal reminders and quotes from policy data.', tag: 'Insurance' },
] as const;

/** Library: a real registry search (read-only), plus labelled samples. No install, scores or prices: the registry gives none. */
export function LibrarySection(props: { workspaceId: string; goTo: (t: StartTarget) => void; onOpenPackage: (id: string) => void }) {
  const { client } = useSession();
  const [filter, setFilter] = useState<string>('All');
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState<{ query: string; result: Result<RegistryPackage[]> } | undefined>();
  const [searching, setSearching] = useState(false);
  const shown = SAMPLE.filter(
    (s) => (filter === 'All' || s.tag === filter) && `${s.name} ${s.text}`.toLowerCase().includes(q.toLowerCase()),
  );
  async function search() {
    const query = q.trim();
    if (query === '') return;
    setSearching(true);
    const result = await client.searchRegistry(props.workspaceId, query);
    setSearching(false);
    setSearched({ query, result });
  }
  return (
    <Section
      id="library-h"
      title="Library"
      lede="Browse XOs to add to your workspace."
      actions={
        <Button variant="primary" onClick={() => props.goTo('create')}>
          + Create XO
        </Button>
      }
    >
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="visually-hidden" htmlFor="lib-q">
          Search the library
        </label>
        <input
          id="lib-q"
          className="searchbox"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by what you need, e.g. “check claim eligibility”…"
        />
        <Button variant="secondary" type="submit" disabled={searching || q.trim() === ''}>
          {searching ? 'Searching…' : 'Search registry'}
        </Button>
      </form>
      {searched !== undefined ? (
        <section aria-label="Registry results" className="stack">
          <h3>Registry results for “{searched.query}”</h3>
          {!searched.result.ok ? <ProblemNotice problem={searched.result.problem} onRetry={() => void search()} /> : null}
          {searched.result.ok && searched.result.value.length === 0 ? <p className="muted small">The registry has nothing for “{searched.query}”.</p> : null}
          {searched.result.ok ? (
            <ul className="xo-grid plain">
              {searched.result.value.map((p) => (
                <li key={p.id} className="xo-card">
                  <div className="row between">
                    <h3>{p.name}</h3>
                    <Badge tone="neutral">v{p.version}</Badge>
                  </div>
                  <p className="mono muted small">{shortDid(p.creatorDid)}</p>
                  <p className="xo-card-text">
                    {p.capabilities.length} {p.capabilities.length === 1 ? 'capability' : 'capabilities'} declared
                  </p>
                  <div className="row between">
                    <Button variant="secondary" aria-label={`Open ${p.name}`} onClick={() => props.onOpenPackage(p.id)}>
                      Open
                    </Button>
                    <Button variant="secondary" aria-disabled title="Installing from the registry is not available yet">
                      Install
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <p className="muted small">The registry can only be searched, not listed. Type what you need and search.</p>
      )}
      <h3>Samples</h3>
      <p className="notice notice-info small">Preview: these are samples, not registry entries. Nothing here can be installed or scored.</p>
      <div className="chips-row" role="group" aria-label="Filter by area">
        {['All', 'Insurance', 'Legal', 'Finance'].map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <ul className="xo-grid plain">
        {shown.map((s) => (
          <li key={s.name} className="xo-card">
            <div className="row between">
              <h3>{s.name}</h3>
              <Badge tone="neutral">Sample</Badge>
            </div>
            <p className="mono muted small">{s.by}</p>
            <p className="xo-card-text">{s.text}</p>
            <div className="row between">
              <span className="muted small">{s.tag}</span>
              <Button variant="secondary" aria-disabled title="The registry is not connected yet">
                Install
              </Button>
            </div>
          </li>
        ))}
        {shown.length === 0 ? <li className="muted small">Nothing matches.</li> : null}
      </ul>
    </Section>
  );
}

const RESULT: Record<string, { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  succeeded: { text: 'Completed', tone: 'success' },
  failed: { text: 'Failed', tone: 'danger' },
  rejected: { text: 'Declined', tone: 'danger' },
  waiting_for_human: { text: 'Escalated', tone: 'warning' },
  interrupted: { text: 'Stopped', tone: 'warning' },
  running: { text: 'Running', tone: 'neutral' },
  created: { text: 'Started', tone: 'neutral' },
};

/** Audit log, as designed, listing what the platform's run records show. It is not a tamper-evident audit record. */
export function AuditSection(props: { runs: readonly WorkflowRun[]; incomplete: boolean }) {
  const rows = useMemo(() => [...props.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.runs]);
  return (
    <Section id="audit-h" title="Audit log" lede="Who ran what, and how it ended, newest first.">
      <p className="notice notice-info small">
        This list is built from run history. A durable, tamper-evident audit log is planned and is not available yet, so this is not an
        audit record.
      </p>
      {props.incomplete ? (
        <p className="notice notice-warning small">Run history could not be fully loaded, so this list may be incomplete.</p>
      ) : null}
      <div className="table" role="table" aria-label="Run events">
        <div className="table-head" role="row">
          <span role="columnheader">Time</span>
          <span role="columnheader">Who</span>
          <span role="columnheader">Event</span>
          <span role="columnheader">Target</span>
          <span role="columnheader">Result</span>
        </div>
        {rows.length === 0 ? <p className="muted small table-empty">No runs recorded yet.</p> : null}
        {rows.map((r) => {
          const res = RESULT[r.status] ?? { text: r.status, tone: 'neutral' as const };
          return (
            <div key={r.workflowExecutionId} className="table-row" role="row">
              <span role="cell" className="mono muted small">
                {formatWhen(r.updatedAt)}
              </span>
              <span role="cell">{r.initiator?.id ?? 'Unknown'}</span>
              <span role="cell">Ran process</span>
              <span role="cell">{runTitle(r)}</span>
              <span role="cell">
                <Badge tone={res.tone}>{res.text}</Badge>
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const SETTINGS_TABS = ['Models and runtime', 'Data and residency', 'Trust and signing', 'Notifications'] as const;

/** Settings, as designed. The detail level is real; everything the platform does not offer yet is shown disabled. */
export function SettingsSection(props: { workspaceName: string }) {
  const { mode, setMode } = useSession();
  const [tab, setTab] = useState<(typeof SETTINGS_TABS)[number]>('Models and runtime');
  const modes: readonly Mode[] = ['user', 'builder'];
  return (
    <Section id="settings-h" title="Settings" lede={`Workspace: ${props.workspaceName}`}>
      <div className="settings">
        <div className="settings-nav" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel">
          <h3>Detail level</h3>
          <p className="muted small">
            User mode keeps to plain language. Builder mode adds technical screens. Neither changes what you are allowed to do.
          </p>
          <div className="radio-list" role="radiogroup" aria-label="Detail level">
            {modes.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className="radio-row" onClick={() => setMode(m)}>
                <span className="radio-dot" aria-hidden="true" />
                {m === 'user' ? 'User mode' : 'Builder mode'}
              </button>
            ))}
          </div>
          <h3>{tab}</h3>
          <p className="notice notice-info small">Not configurable in Studio yet. These are set when the platform starts.</p>
          <div className="radio-list" aria-disabled="true">
            {['This computer', 'Private server', 'Cloud'].map((x) => (
              <div key={x} className="radio-row" data-off="true">
                <span className="radio-dot" aria-hidden="true" />
                {x}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

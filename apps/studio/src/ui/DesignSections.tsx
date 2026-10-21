import { useMemo, useState } from 'react';
import type { Result } from '../platform/client';
import type { RegistryPackage, WorkflowRun } from '../platform/wire';
import type { StartTarget } from '../domain/start';
import { shortDid, type XoItem } from '../domain/xo';
import { Badge, Button, formatWhen, ProblemNotice } from './primitives';
import { runTitle } from './RunCard';
import { useSession, type Mode } from './session';
import { useTheme, type Theme } from './theme';

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

const SWATCHES = ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--violet)'] as const;
/** A colour square beside a name is decoration only; it carries no meaning. It is chosen from the name so it stays the same. */
const swatch = (name: string): string => SWATCHES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % SWATCHES.length]!;

interface LibraryCard {
  readonly key: string;
  readonly name: string;
  readonly badge: string;
  readonly by: string;
  readonly text: string;
  readonly status: string;
  readonly action: { readonly label: string; readonly onClick?: () => void; readonly unavailable?: string };
  readonly groups: readonly string[];
}

const FILTERS = ['All', 'Insurance', 'Legal', 'Finance', 'Made by me', 'My company'] as const;

/**
 * Library, as designed. Three real sources feed it: XOs made from your own documents ("Made by me"), a read-only search of
 * this workspace's registry ("My company"), and labelled samples. The registry gives no score, rating, price or "verified"
 * flag, so none is shown; Install is not available.
 */
export function LibrarySection(props: {
  workspaceId: string;
  goTo: (t: StartTarget) => void;
  onOpenPackage: (id: string) => void;
  mine: readonly XoItem[];
  onOpenMine: (compilationId: string) => void;
}) {
  const { client } = useSession();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState<{ query: string; result: Result<RegistryPackage[]> } | undefined>();
  const [searching, setSearching] = useState(false);
  async function search() {
    const query = q.trim();
    if (query === '') return;
    setSearching(true);
    const result = await client.searchRegistry(props.workspaceId, query);
    setSearching(false);
    setSearched({ query, result });
  }
  const needle = q.trim().toLowerCase();
  const mine: LibraryCard[] = props.mine
    .filter((x) => needle === '' || x.label.toLowerCase().includes(needle))
    .map((x) => ({
      key: `m-${x.id}`,
      name: x.label,
      badge: 'Analysed',
      by: 'You · this workspace',
      text: 'Built from your own document. Open it to see the rules XO found.',
      status: 'Made by me',
      action: { label: 'Open', onClick: () => props.onOpenMine(x.id) },
      groups: ['Made by me'],
    }));
  const registry: LibraryCard[] =
    searched?.result.ok === true
      ? searched.result.value.map((p) => ({
          key: `r-${p.id}`,
          name: p.name,
          badge: `v${p.version}`,
          by: shortDid(p.creatorDid),
          text: `${p.capabilities.length} ${p.capabilities.length === 1 ? 'capability' : 'capabilities'} declared`,
          status: 'In your registry',
          action: { label: 'Open', onClick: () => props.onOpenPackage(p.id) },
          groups: ['My company'],
        }))
      : [];
  const samples: LibraryCard[] = SAMPLE.filter((s) => needle === '' || `${s.name} ${s.text}`.toLowerCase().includes(needle)).map((s) => ({
    key: `s-${s.name}`,
    name: s.name,
    badge: 'Sample',
    by: s.by,
    text: s.text,
    status: s.tag,
    action: { label: 'Install', unavailable: 'Installing is not available yet' },
    groups: [s.tag],
  }));
  const all = [...mine, ...registry, ...samples];
  const shown = filter === 'All' ? all : all.filter((c) => c.groups.includes(filter));
  return (
    <section className="section" aria-labelledby="library-h">
      <header className="section-head">
        <h2 id="library-h">Library</h2>
        <div className="section-actions">
          <Button variant="primary" onClick={() => props.goTo('create')}>
            + Create XO
          </Button>
        </div>
      </header>
      <form
        className="lib-search"
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
        <Button variant="quiet" type="submit" disabled={searching || q.trim() === ''}>
          {searching ? 'Searching…' : 'Search registry'}
        </Button>
      </form>
      <div className="chips-row" role="group" aria-label="Filter by area">
        {FILTERS.map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      {searched !== undefined && !searched.result.ok ? <ProblemNotice problem={searched.result.problem} onRetry={() => void search()} /> : null}
      {searched?.result.ok === true && searched.result.value.length === 0 ? (
        <p className="muted small" role="status">
          The registry has nothing for “{searched.query}”.
        </p>
      ) : null}
      {searched === undefined ? <p className="muted small">The registry can only be searched, not listed. Type what you need and choose Search registry.</p> : null}
      <ul className="xo-grid bare-list" aria-label="XOs">
        {shown.map((c) => (
          <li key={c.key} className="xo-card">
            <div className="row between">
              <h3>
                <span className="xo-swatch" style={{ background: swatch(c.name) }} aria-hidden="true" />
                {c.name}
              </h3>
              <Badge tone="neutral">{c.badge}</Badge>
            </div>
            <p className="mono muted small">{c.by}</p>
            <p className="xo-card-text">{c.text}</p>
            <div className="row between">
              <span className="muted small">{c.status}</span>
              {c.action.unavailable !== undefined ? (
                <Button variant="secondary" aria-disabled title={c.action.unavailable}>
                  {c.action.label}
                </Button>
              ) : (
                <Button variant="secondary" aria-label={`${c.action.label} ${c.name}`} onClick={c.action.onClick}>
                  {c.action.label}
                </Button>
              )}
            </div>
          </li>
        ))}
        {shown.length === 0 ? <li className="muted small">Nothing matches.</li> : null}
      </ul>
      <p className="muted small">
        Cards marked Sample are examples, not registry entries. Scores, ratings, prices and “verified” are not available because the registry does not provide them.
      </p>
    </section>
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

const ROLES = ['Admin', 'Publisher', 'Reviewer', 'Viewer'] as const;

/**
 * Audit log, as designed. The table lists what the platform's run records show. It is not a tamper-evident audit record,
 * and the filters beyond "All events" and "Runs", the export, the roles and the integrity statement are not available yet.
 */
export function AuditSection(props: { runs: readonly WorkflowRun[]; incomplete: boolean }) {
  const rows = useMemo(() => [...props.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.runs]);
  return (
    <section className="section" aria-labelledby="audit-h">
      <header className="section-head">
        <h2 id="audit-h">Audit log</h2>
        <div className="section-actions">
          <Button variant="secondary" aria-disabled title="Exporting is not available yet">
            Export for SOC 2
          </Button>
        </div>
      </header>
      <div className="chips-row" role="group" aria-label="Filter events">
        <button type="button" className="chip" aria-pressed="true">
          All events
        </button>
        {['Publishing', 'Access denied'].map((f) => (
          <button key={f} type="button" className="chip" aria-disabled="true" title={`${f} events are not recorded yet`}>
            {f}
          </button>
        ))}
        <button type="button" className="chip" aria-pressed="false" aria-disabled="true" title="Runs are the only events recorded, so this equals All events">
          Runs
        </button>
        <button type="button" className="chip" aria-disabled="true" title="Choosing a period is not available yet">
          Last 7 days ▾
        </button>
      </div>
      {props.incomplete ? (
        <p className="notice notice-warning small">Run history could not be fully loaded, so this list may be incomplete.</p>
      ) : null}
      <div className="audit-grid">
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
        <aside className="audit-side" aria-label="Roles and integrity">
          <section className="xoi-card" aria-labelledby="roles-h">
            <div className="row between">
              <h3 id="roles-h">Roles</h3>
              <Badge tone="neutral">Not available yet</Badge>
            </div>
            <ul className="bare-list audit-roles" aria-disabled="true">
              {ROLES.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <Button variant="quiet" aria-disabled title="Inviting members is not available yet">
              + Invite member
            </Button>
          </section>
          <section className="xoi-card" aria-labelledby="integ-h">
            <h3 id="integ-h">Integrity</h3>
            <p className="muted small">
              Not available yet. This list is built from run history. It is not append-only or tamper-evident, and no retention period is recorded, so it is not an audit
              record.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}

const SETTINGS_TABS = ['General', 'Models and runtime', 'Data and residency', 'Trust and signing', 'Notifications'] as const;

function Unavailable(props: { children: string }) {
  return <p className="notice notice-info small">{props.children}</p>;
}

/** Settings, as designed. Detail level and theme are real; everything the platform does not offer yet is shown disabled and says so. */
export function SettingsSection(props: { workspaceName: string }) {
  const { mode, setMode } = useSession();
  const [tab, setTab] = useState<(typeof SETTINGS_TABS)[number]>('General');
  const modes: readonly Mode[] = ['user', 'builder'];
  const [theme, setTheme] = useTheme();
  return (
    <section className="section" aria-labelledby="settings-h">
      <h2 id="settings-h" className="visually-hidden">
        Settings
      </h2>
      <div className="settings">
        <div className="settings-nav" role="tablist" aria-label="Settings sections">
          <p className="settings-title" aria-hidden="true">
            Settings
          </p>
          {SETTINGS_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" aria-label={tab}>
          {tab === 'General' ? (
            <>
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
              <h3>Appearance</h3>
              <div className="radio-list" role="radiogroup" aria-label="Theme">
                {(['dark', 'light'] as const satisfies readonly Theme[]).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={theme === t} className="radio-row" onClick={() => setTheme(t)}>
                    <span className="radio-dot" aria-hidden="true" />
                    {t === 'dark' ? 'Dark theme' : 'Light theme'}
                  </button>
                ))}
              </div>
              <h3>Workspace</h3>
              <p>{props.workspaceName}</p>
            </>
          ) : null}
          {tab === 'Models and runtime' ? (
            <>
              <h3>Where XOs run</h3>
              <Unavailable>Not configurable in Studio yet. These are set when the platform starts.</Unavailable>
              <div className="radio-list" aria-disabled="true">
                {['This computer', 'Private server', 'Cloud'].map((x) => (
                  <div key={x} className="radio-row" data-off="true">
                    <span className="radio-dot" aria-hidden="true" />
                    {x}
                  </div>
                ))}
              </div>
              <h3>Model</h3>
              <div className="radio-list" aria-disabled="true">
                <div className="radio-row" data-off="true">
                  Model choice is not available yet
                </div>
                <div className="radio-row" data-off="true">
                  Fallback model is not available yet
                </div>
              </div>
              <div className="radio-row" data-off="true" aria-disabled="true">
                <span>
                  Air-gapped mode <span className="muted small">· Not available yet</span>
                </span>
              </div>
              <h3>Data residency</h3>
              <div className="radio-row" data-off="true" aria-disabled="true">
                Not available yet
              </div>
            </>
          ) : null}
          {tab !== 'General' && tab !== 'Models and runtime' ? (
            <>
              <h3>{tab}</h3>
              <Unavailable>Not available yet. Studio has no settings for this, and shows none rather than imitate them.</Unavailable>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

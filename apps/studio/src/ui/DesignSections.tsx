import { useState } from 'react';
import type { Result } from '../platform/client';
import type { RegistryPackage } from '../platform/wire';
import type { StartTarget } from '../domain/start';
import { shortDid, type XoItem } from '../domain/xo';
import { Badge, Button, ProblemNotice } from './primitives';
import { useSession } from './session';

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
      {searched !== undefined && !searched.result.ok ? (
        <ProblemNotice problem={searched.result.problem} onRetry={() => void search()} />
      ) : null}
      {searched?.result.ok === true && searched.result.value.length === 0 ? (
        <p className="muted small" role="status">
          The registry has nothing for “{searched.query}”.
        </p>
      ) : null}
      {searched === undefined ? (
        <p className="muted small">The registry can only be searched, not listed. Type what you need and choose Search registry.</p>
      ) : null}
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
        Cards marked Sample are examples, not registry entries. Scores, ratings, prices and “verified” are not available because the
        registry does not provide them.
      </p>
    </section>
  );
}

import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { StartTarget } from '../domain/start';
import { shortDid, type XoItem } from '../domain/xo';
import type { ApiProblem } from '../platform/client';
import type { Workspace } from '../platform/wire';
import type { LibraryDetail, LibraryItem } from '../platform/wire-studio';
import { Badge, Button, EmptyState, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

const FILTERS = ['All', 'Installed', 'Made by me'] as const;
type Filter = (typeof FILTERS)[number];

const SWATCHES = ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--violet)'] as const;
/** A colour square beside a name is decoration only; it carries no meaning. It is chosen from the name so it stays the same. */
const swatch = (name: string): string => SWATCHES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % SWATCHES.length]!;

/**
 * Library. Two real sources: XOs made from your own documents (not yet packaged) and the packages published to THIS
 * workspace's registry. There is no public catalog behind it, so there are no ratings, prices or marketplace entries
 * here, and none are shown.
 *
 * Trust lines say only what the records say:
 *  - "Signature entries present" is exactly that. XO has no way to check a signature or know whose key it is, so a
 *    signed package is NEVER shown as verified.
 *  - A score is the mean of the latest benchmark run in each category. Runs do not record who ran them, so a score is
 *    never shown as independently verified.
 */
export function LibraryScreen(props: {
  workspace: Workspace;
  goTo: (t: StartTarget) => void;
  onOpenPackage: (id: string) => void;
  mine: readonly XoItem[];
  onOpenMine: (compilationId: string) => void;
}) {
  const { client } = useSession();
  const ws = props.workspace.workspaceId;
  const [filter, setFilter] = useState<Filter>('All');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const library = useLoad(() => client.listLibrary(ws, query === '' ? {} : { q: query }), [client, ws, query]);
  const [problems, setProblems] = useState<Readonly<Record<string, ApiProblem>>>({});
  const [busy, setBusy] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const canInstall = can(props.workspace.role, 'author');
  const installHint = canInstall ? undefined : whyNot(props.workspace.role, 'author', 'installing or removing XOs');

  async function act(item: LibraryItem, action: 'install' | 'uninstall') {
    setBusy(item.id);
    setProblems(({ [item.id]: _gone, ...rest }) => rest);
    const r = action === 'install' ? await client.installPackage(ws, item.id) : await client.uninstallPackage(ws, item.name, item.version);
    setBusy(undefined);
    if (!r.ok) {
      const problem = r.problem;
      setProblems((p) => ({ ...p, [item.id]: problem }));
      return;
    }
    library.reload();
  }

  const loaded = loadedValue(library.state);
  const needle = query.toLowerCase();
  const analysed = props.mine.filter((x) => needle === '' || x.label.toLowerCase().includes(needle));
  const registry = (loaded?.items ?? []).filter((i) =>
    filter === 'Installed' ? i.installed : filter === 'Made by me' ? i.madeByMe : true,
  );
  const showAnalysed = filter === 'All' || filter === 'Made by me';
  const nothing = loaded !== undefined && registry.length === 0 && (!showAnalysed || analysed.length === 0);

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
          setQuery(draft.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="lib-q">
          Search the library
        </label>
        <input
          id="lib-q"
          className="searchbox"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search by name or what it does, e.g. “claims”…"
        />
        <Button variant="quiet" type="submit">
          Search
        </Button>
        {query !== '' ? (
          <Button
            variant="quiet"
            onClick={() => {
              setDraft('');
              setQuery('');
            }}
          >
            Clear
          </Button>
        ) : null}
      </form>
      <div className="chips-row" role="group" aria-label="Filter the library">
        {FILTERS.map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
            {loaded !== undefined && f !== 'All' ? (
              <span className="muted small"> {f === 'Installed' ? loaded.counts.installed : loaded.counts.mine + analysed.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      {library.state.phase === 'loading' ? <Skeleton label="Loading the library" rows={3} /> : null}
      {library.state.phase === 'error' ? <ProblemNotice problem={library.state.problem} onRetry={library.reload} /> : null}
      <ul className="xo-grid bare-list" aria-label="XOs">
        {showAnalysed
          ? analysed.map((x) => (
              <li key={`m-${x.id}`} className="xo-card">
                <div className="row between">
                  <h3>
                    <span className="xo-swatch" style={{ background: swatch(x.label) }} aria-hidden="true" />
                    {x.label}
                  </h3>
                  <Badge tone="neutral">Analysed</Badge>
                </div>
                <p className="mono muted small">You · this workspace</p>
                <p className="xo-card-text">Built from your own document. Open it to see the rules XO found.</p>
                <div className="row between">
                  <span className="muted small">Not published</span>
                  <Button variant="secondary" aria-label={`Open ${x.label}`} onClick={() => props.onOpenMine(x.id)}>
                    Open
                  </Button>
                </div>
              </li>
            ))
          : null}
        {registry.map((item) => (
          <li key={item.id} className="xo-card">
            <div className="row between">
              <h3>
                <span className="xo-swatch" style={{ background: swatch(item.name) }} aria-hidden="true" />
                {item.name}
              </h3>
              <Badge tone="neutral">v{item.version}</Badge>
            </div>
            <p className="mono muted small">{item.madeByMe ? 'You' : shortDid(item.creatorDid)} · this workspace</p>
            <p className="xo-card-text">
              {item.summary ?? `${item.capabilities.length} ${item.capabilities.length === 1 ? 'capability' : 'capabilities'} declared`}
            </p>
            <ul className="bare-list xo-trust small" aria-label={`What is recorded about ${item.name}`}>
              <li>{item.trust.signed ? `Signature entries present (${item.trust.signerCount}) — not checked` : 'No signature entries'}</li>
              <li>
                {item.trust.benchmarked
                  ? `Benchmark score ${item.trust.overallScore ?? '—'} — recorded by the publisher, not independently verified`
                  : 'No benchmark runs recorded'}
              </li>
            </ul>
            {problems[item.id] !== undefined ? <ProblemNotice problem={problems[item.id]!} /> : null}
            <div className="row between">
              <span className="muted small">{item.installed ? 'Installed' : 'In your registry'}</span>
              <span className="card-actions">
                <Button variant="quiet" aria-label={`Open ${item.name}`} onClick={() => props.onOpenPackage(item.id)}>
                  Open
                </Button>
                <Button
                  variant="quiet"
                  aria-expanded={open === item.id}
                  aria-label={`Details for ${item.name}`}
                  onClick={() => setOpen(open === item.id ? undefined : item.id)}
                >
                  Details
                </Button>
                {item.installed ? (
                  <Button
                    variant="secondary"
                    disabled={!canInstall || busy === item.id}
                    title={installHint}
                    aria-label={`Uninstall ${item.name}`}
                    onClick={() => void act(item, 'uninstall')}
                  >
                    {busy === item.id ? 'Removing…' : 'Uninstall'}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={!canInstall || busy === item.id}
                    title={installHint}
                    aria-label={`Install ${item.name}`}
                    onClick={() => void act(item, 'install')}
                  >
                    {busy === item.id ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </span>
            </div>
            {open === item.id ? <PackageDetails workspaceId={ws} id={item.id} /> : null}
          </li>
        ))}
      </ul>
      {nothing ? (
        <EmptyState
          title={query !== '' ? `Nothing matches “${query}”` : filter === 'Installed' ? 'Nothing is installed yet' : 'No XOs here yet'}
        >
          {query !== ''
            ? 'Try different words, or clear the search.'
            : 'XOs appear here when they are published to this workspace, or when you build one from your own document with + Create XO.'}
        </EmptyState>
      ) : null}
      <p className="muted small">
        This library is this workspace&apos;s own registry: there is no public catalog, price or rating. A signature entry is shown as
        present, never as verified, because XO cannot check who signed a package. A score comes from benchmark runs the publisher recorded;
        XO does not record who ran them.
      </p>
    </section>
  );
}

function PackageDetails(props: { workspaceId: string; id: string }) {
  const { client } = useSession();
  const detail = useLoad(() => client.getLibraryPackage(props.workspaceId, props.id), [client, props.workspaceId, props.id]);
  const d: LibraryDetail | undefined = loadedValue(detail.state);
  return (
    <div className="xo-details" role="region" aria-label="Package details">
      {detail.state.phase === 'loading' ? <Skeleton label="Loading details" rows={2} /> : null}
      {detail.state.phase === 'error' ? <ProblemNotice problem={detail.state.problem} onRetry={detail.reload} /> : null}
      {d !== undefined ? (
        <>
          {Object.keys(d.byCategory).length === 0 ? (
            <p className="muted small">No benchmark scores recorded.</p>
          ) : (
            <ul className="bare-list small" aria-label="Latest score per category">
              {Object.entries(d.byCategory).map(([cat, score]) => (
                <li key={cat} className="row between">
                  <span>{cat.replace(/_/g, ' ')}</span>
                  <span className="mono">{score}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            {d.runs} {d.runs === 1 ? 'run' : 'runs'} recorded.{' '}
            {d.signers.length === 0
              ? 'No signature entries.'
              : `Signature entries from ${d.signers.length} ${d.signers.length === 1 ? 'signer' : 'signers'} are present but not checked.`}
          </p>
          {d.installable ? null : (
            <p className="notice notice-warning small">
              The original package file was not kept for this XO, so it cannot be installed from here. Publish it again to make it
              installable.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

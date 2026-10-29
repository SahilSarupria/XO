import { useState, type ReactNode } from 'react';
import {
  barPercent,
  categoryLabel,
  knowledgeGraph,
  latestByCategory,
  needsInput,
  ruleCounts,
  shortDid,
  toKnowledgeItems,
  type KnowledgeItem,
  type KnowledgeState,
  type XoSubject,
} from '../domain/xo';
import { REVIEW_STATE_LABEL, reviewStateOf } from '../domain/review';
import type { StartTarget } from '../domain/start';
import type { BenchmarkRun, Capability, Compilation, RegistryPackage, Source } from '../platform/wire';
import { documentLabel } from '../domain/xo';
import { Badge, Button, EmptyState, formatBytes, formatWhen, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';
import '../styles/xo.css';

type Tab = 'overview' | 'knowledge' | 'rules' | 'benchmarks' | 'versions';
const TABS: readonly [Tab, string][] = [
  ['overview', 'Overview'],
  ['knowledge', 'Knowledge'],
  ['rules', 'Rules'],
  ['benchmarks', 'Benchmarks'],
  ['versions', 'Versions'],
];

/** One screen for an XO, whichever kind it is: an analysed document of this workspace, or a package from the registry. */
export function XoInspector(props: {
  workspaceId: string;
  subject: XoSubject;
  compilations: readonly Compilation[];
  sources: readonly Source[];
  onBack: () => void;
  goTo: (t: StartTarget) => void;
}) {
  return props.subject.kind === 'analysis' ? (
    <AnalysisInspector {...props} id={props.subject.id} />
  ) : (
    <PackageInspector workspaceId={props.workspaceId} id={props.subject.id} onBack={props.onBack} goTo={props.goTo} />
  );
}

function Frame(props: {
  title: string;
  mono: string;
  badge: ReactNode;
  tab: Tab;
  onTab: (t: Tab) => void;
  onBack: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="xoi" aria-label="XO">
      <button type="button" className="crumb-link xoi-back" onClick={props.onBack}>
        ← My XOs
      </button>
      <header className="xoi-head">
        <h1>{props.title}</h1>
        <span className="mono">{props.mono}</span>
        {props.badge}
        <div className="xoi-actions">{props.actions}</div>
      </header>
      <div className="xoi-tabs" role="tablist" aria-label="XO views">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={props.tab === id} onClick={() => props.onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="xoi-body">
        {props.children}
      </div>
    </section>
  );
}

const STATE_LABEL: Record<KnowledgeState, string> = { ...REVIEW_STATE_LABEL, declared: 'Declared' };

function Stat(props: { label: string; value: string | number; note?: string }) {
  return (
    <div className="xoi-stat">
      <p className="xoi-stat-label">{props.label}</p>
      <p className="xoi-stat-value">{props.value}</p>
      {props.note !== undefined ? <p className="muted small">{props.note}</p> : null}
    </div>
  );
}

function KnowledgeGraphCard(props: { label: string; items: readonly KnowledgeItem[]; legend: readonly KnowledgeState[] }) {
  const g = knowledgeGraph(props.label, props.items);
  return (
    <section className="xoi-card" aria-labelledby="kg-h">
      <h2 id="kg-h">Knowledge graph</h2>
      {props.items.length === 0 ? (
        <p className="muted small">Nothing to draw yet: no rules are recorded for this XO.</p>
      ) : (
        <>
          <svg
            className="xoi-kg"
            viewBox={`0 0 ${g.width} ${g.height}`}
            role="img"
            aria-label={`${props.label} and its ${props.items.length} rules`}
          >
            {g.nodes.map((n) => (
              <line key={`l-${n.id}`} x1={g.center.x} y1={g.center.y} x2={n.x} y2={n.y} />
            ))}
            {g.nodes.map((n) => (
              <circle key={n.id} cx={n.x} cy={n.y} r="9" data-state={n.state}>
                <title>{`${n.label}: ${STATE_LABEL[n.state]}`}</title>
              </circle>
            ))}
            <circle cx={g.center.x} cy={g.center.y} r="26" className="xoi-kg-center" />
            <text x={g.center.x} y={g.center.y + 4} textAnchor="middle">
              {props.label.length > 9 ? `${props.label.slice(0, 8)}…` : props.label}
            </text>
          </svg>
          {g.hidden > 0 ? (
            <p className="muted small">
              Showing {g.nodes.length} of {props.items.length} rules. All of them are listed under Rules.
            </p>
          ) : null}
          <ul className="xoi-legend bare-list">
            {props.legend.map((s) => (
              <li key={s}>
                <span className="xoi-kg-dot" data-state={s} aria-hidden="true" /> {STATE_LABEL[s]}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ an analysed document of this workspace
function AnalysisInspector(props: {
  workspaceId: string;
  id: string;
  compilations: readonly Compilation[];
  sources: readonly Source[];
  onBack: () => void;
  goTo: (t: StartTarget) => void;
}) {
  const { client, mode } = useSession();
  const [tab, setTab] = useState<Tab>('overview');
  const c = props.compilations.find((x) => x.compilationId === props.id);
  const source = c === undefined ? undefined : props.sources.find((s) => s.sourceId === c.sourceId);
  const caps = useLoad(() => client.getCapabilities(props.workspaceId, props.id), [client, props.workspaceId, props.id]);
  const label = source === undefined ? 'Analysed document' : documentLabel(source.originalFilename);
  if (c === undefined) {
    return (
      <EmptyState title="This XO is no longer in the workspace">
        <Button variant="secondary" onClick={props.onBack}>
          Back to My XOs
        </Button>
      </EmptyState>
    );
  }
  const list: readonly Capability[] =
    caps.state.phase === 'ready' ? caps.state.value : caps.state.phase === 'error' ? (caps.state.stale ?? []) : [];
  const counts = ruleCounts(list);
  const versions = props.compilations.filter((x) => x.sourceId === c.sourceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Frame
      title={label}
      mono={`analysed ${formatWhen(c.completedAt ?? c.createdAt)}`}
      badge={<Badge tone="neutral">Analysed</Badge>}
      tab={tab}
      onTab={setTab}
      onBack={props.onBack}
      actions={
        <>
          <button type="button" className="btn btn-secondary" aria-disabled="true" title="Forking is not available yet">
            Fork
          </button>
          <Button variant="primary" onClick={() => props.goTo('workflows')}>
            Use in workflow
          </Button>
        </>
      }
    >
      {caps.state.phase === 'loading' ? <Skeleton label="Loading rules" /> : null}
      {caps.state.phase === 'error' ? <ProblemNotice problem={caps.state.problem} onRetry={caps.reload} /> : null}
      {tab === 'overview' ? (
        <>
          <div className="xoi-stats">
            <Stat label="Rules found" value={counts.total} />
            <Stat label="Approved" value={counts.approved} />
            <Stat label="Ready for review" value={counts.readyForReview} />
            <Stat label="Need more information" value={counts.needsAttention} />
          </div>
          <div className="xoi-two">
            <section className="xoi-card" aria-labelledby="bm-h">
              <h2 id="bm-h">Benchmark by category</h2>
              <p className="muted small">
                Not available yet. No benchmark has been run for this XO. Benchmarks are recorded by the registry for published XOs.
              </p>
            </section>
            <KnowledgeGraphCard label={label} items={toKnowledgeItems(list)} legend={['approved', 'ready_for_review', 'needs_attention']} />
          </div>
        </>
      ) : null}
      {tab === 'knowledge' ? (
        <section className="xoi-card">
          <h2>Source document</h2>
          {source === undefined ? (
            <p className="muted small">The document this was analysed from is no longer listed.</p>
          ) : (
            <dl className="xoi-dl">
              <dt>File</dt>
              <dd>{source.originalFilename}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(source.byteSize)}</dd>
              <dt>Added</dt>
              <dd>{formatWhen(source.createdAt)}</dd>
              {mode === 'builder' ? (
                <>
                  <dt>sha256</dt>
                  <dd className="mono">{source.digestSha256}</dd>
                </>
              ) : null}
            </dl>
          )}
          <p className="muted small">Each rule keeps the pages it came from. They are listed under Rules.</p>
        </section>
      ) : null}
      {tab === 'rules' ? (
        <section className="xoi-card">
          <div className="row between">
            <h2>Rules</h2>
            <Button variant="secondary" onClick={() => props.goTo('rules')}>
              Review and approve
            </Button>
          </div>
          {needsInput(list).length > 0 ? (
            <p className="notice notice-warning small" role="status">
              {needsInput(list).length} {needsInput(list).length === 1 ? 'rule needs' : 'rules need'} more information before XO can use{' '}
              {needsInput(list).length === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
          {list.length === 0 && caps.state.phase === 'ready' ? <p className="muted small">XO found no rules in this document.</p> : null}
          <ul className="xoi-rules bare-list">
            {list.map((r) => {
              const pages = r.provenance.flatMap((p) => p.pages ?? []);
              return (
                <li key={r.capabilityId}>
                  <div className="row between">
                    <strong>{r.name}</strong>
                    <Badge
                      tone={reviewStateOf(r) === 'approved' ? 'success' : reviewStateOf(r) === 'ready_for_review' ? 'accent' : 'warning'}
                    >
                      {REVIEW_STATE_LABEL[reviewStateOf(r)]}
                    </Badge>
                  </div>
                  <p className="muted small">{r.description}</p>
                  <p className="mono">
                    confidence {r.confidence.toFixed(2)}
                    {pages.length > 0 ? ` · page ${[...new Set(pages)].join(', ')}` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {tab === 'benchmarks' ? (
        <EmptyState title="No benchmark runs">
          This XO has not been published, so the registry has recorded no benchmark runs for it.
        </EmptyState>
      ) : null}
      {tab === 'versions' ? (
        <section className="xoi-card">
          <h2>Analyses of this document</h2>
          <ul className="xoi-rules bare-list">
            {versions.map((v) => (
              <li key={v.compilationId} className="row between">
                <span>
                  {formatWhen(v.completedAt ?? v.createdAt)}{' '}
                  {v.compilationId === c.compilationId ? <Badge tone="accent">Shown</Badge> : null}
                </span>
                <Badge tone={v.status === 'succeeded' ? 'success' : v.status === 'failed' ? 'danger' : 'neutral'}>
                  {v.status === 'succeeded' ? 'Analysed' : v.status === 'failed' ? 'Did not finish' : 'Analysing'}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Frame>
  );
}

// ------------------------------------------------------------------ a package from the registry
function PackageInspector(props: { workspaceId: string; id: string; onBack: () => void; goTo: (t: StartTarget) => void }) {
  const { client } = useSession();
  const [tab, setTab] = useState<Tab>('overview');
  const r = useLoad(() => client.inspectPackage(props.workspaceId, props.id), [client, props.workspaceId, props.id]);
  if (r.state.phase === 'loading') return <Skeleton label="Loading this XO" />;
  if (r.state.phase === 'error' && r.state.stale === undefined)
    return (
      <div className="stack">
        <ProblemNotice problem={r.state.problem} onRetry={r.reload} />
        <Button variant="secondary" onClick={props.onBack}>
          Back to My XOs
        </Button>
      </div>
    );
  const data = r.state.phase === 'ready' ? r.state.value : r.state.phase === 'error' ? r.state.stale! : undefined;
  if (data === undefined) return null;
  return <PackageView record={data.record} runs={data.runs} tab={tab} onTab={setTab} onBack={props.onBack} />;
}

function PackageView(props: {
  record: RegistryPackage;
  runs: readonly BenchmarkRun[];
  tab: Tab;
  onTab: (t: Tab) => void;
  onBack: () => void;
}) {
  const p = props.record;
  const cats = latestByCategory(props.runs);
  const open = props.runs.filter((x) => x.challengeable).length;
  return (
    <Frame
      title={p.name}
      mono={`v${p.version}`}
      badge={<Badge tone="neutral">Published</Badge>}
      tab={props.tab}
      onTab={props.onTab}
      onBack={props.onBack}
      actions={
        <>
          <button type="button" className="btn btn-secondary" aria-disabled="true" title="Forking is not available yet">
            Fork
          </button>
          <button type="button" className="btn btn-primary" aria-disabled="true" title="Installing from the registry is not available yet">
            Use in workflow
          </button>
        </>
      }
    >
      {props.tab === 'overview' ? (
        <>
          <div className="xoi-stats">
            <Stat label="Version" value={p.version} />
            <Stat label="Capabilities declared" value={p.capabilities.length} />
            <Stat label="Signatures on the manifest" value={p.signatureCount} note="Not checked here" />
            <Stat label="Benchmark runs recorded" value={props.runs.length} />
          </div>
          <div className="xoi-two">
            <section className="xoi-card" aria-labelledby="bm-h">
              <h2 id="bm-h">Benchmark by category</h2>
              {cats.length === 0 ? (
                <p className="muted small">No benchmark run has been recorded for this package.</p>
              ) : (
                <>
                  <ul className="xoi-bars bare-list">
                    {cats.map((c) => {
                      const pct = barPercent(c.score);
                      return (
                        <li key={c.category}>
                          <span>{categoryLabel(c.category)}</span>
                          <span className="xoi-bar" aria-hidden="true">
                            {pct !== undefined ? <span style={{ width: `${pct}%` }} /> : null}
                          </span>
                          <span className="mono">{c.score}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mono">
                    latest run in each category · {props.runs.length} {props.runs.length === 1 ? 'run' : 'runs'} recorded · {open} marked
                    challengeable
                  </p>
                </>
              )}
            </section>
            <KnowledgeGraphCard
              label={p.name}
              items={p.capabilities.map((c) => ({ id: c.id, name: c.name, state: 'declared' as const }))}
              legend={['declared']}
            />
          </div>
        </>
      ) : null}
      {props.tab === 'knowledge' ? (
        <section className="xoi-card">
          <h2>What the package contains</h2>
          <dl className="xoi-dl">
            <dt>Creator</dt>
            <dd className="mono">{shortDid(p.creatorDid)}</dd>
            <dt>Published</dt>
            <dd>{formatWhen(p.publishedAt)}</dd>
            {p.components.map((c) => (
              <div key={c.kind} className="xoi-dl-row">
                <dt>{categoryLabel(c.kind)}</dt>
                <dd className="mono">{c.path}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {props.tab === 'rules' ? (
        <section className="xoi-card">
          <h2>Capabilities it declares</h2>
          {p.capabilities.length === 0 ? <p className="muted small">This package declares no capabilities.</p> : null}
          <ul className="xoi-rules bare-list">
            {p.capabilities.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong>
                <p className="muted small">{c.description}</p>
                <p className="mono">{c.id}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.tab === 'benchmarks' ? (
        <section className="xoi-card">
          <h2>Recorded runs</h2>
          {props.runs.length === 0 ? <p className="muted small">No benchmark run has been recorded for this package.</p> : null}
          <ul className="xoi-rules bare-list">
            {[...props.runs]
              .sort((a, b) => b.runAt.localeCompare(a.runAt))
              .map((r) => (
                <li key={r.id} className="row between">
                  <span>
                    {categoryLabel(r.category)} <span className="muted small">· {formatWhen(r.runAt)}</span>
                  </span>
                  <span className="mono">
                    {r.score}
                    {r.challengeable ? ' · challengeable' : ''}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      {props.tab === 'versions' ? (
        <section className="xoi-card">
          <h2>Versions in your registry</h2>
          <p>
            v{p.version} <span className="muted small">· published {formatWhen(p.publishedAt)}</span>
          </p>
          <p className="muted small">Only this version is held in this workspace&rsquo;s registry.</p>
        </section>
      ) : null}
    </Frame>
  );
}

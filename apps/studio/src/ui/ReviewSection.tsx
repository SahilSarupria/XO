import { useMemo, useState } from 'react';
import { canApprove, canRun, executionClassLabel, latestExecutionByCapability, REVIEW_STATE_EXPLANATION, REVIEW_STATE_LABEL, reviewStateOf, summarize, type ReviewState } from '../domain/review';
import type { ApiProblem } from '../platform/client';
import type { Capability, Compilation, Execution } from '../platform/wire';
import { Badge, Button, EmptyState, formatWhen, ProblemNotice, Section, Spinner, type LoadState } from './primitives';
import { ExecutionOutcome, RunPanel } from './runs';
import { useSession } from './session';

type Filter = 'all' | ReviewState;
const TONE: Record<ReviewState, 'warning' | 'accent' | 'success'> = { needs_attention: 'warning', ready_for_review: 'accent', approved: 'success' };

export function ReviewSection(props: {
  workspaceId: string;
  compilation: Compilation | undefined;
  compilations: Compilation[];
  onPickCompilation: (id: string) => void;
  caps: LoadState<Capability[]>;
  executions: Execution[];
  onChanged: () => void;
  goToContext: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const compilation = props.compilation;
  const latest = useMemo(() => (compilation === undefined ? new Map<string, Execution>() : latestExecutionByCapability(props.executions, compilation.compilationId)), [props.executions, compilation]);

  if (compilation === undefined) {
    return (
      <Section id="review-h" title="Review">
        <EmptyState title="Nothing to review yet">
          Analyse a document first. XO will list the rules it finds here, with the evidence for each.
        </EmptyState>
        <Button variant="primary" onClick={props.goToContext}>
          Go to Context
        </Button>
      </Section>
    );
  }
  if (props.caps.phase === 'loading') return <Section id="review-h" title="Review"><Spinner label="Loading what XO found" /></Section>;
  if (props.caps.phase === 'error') return <Section id="review-h" title="Review"><ProblemNotice problem={props.caps.problem} onRetry={props.onChanged} /></Section>;

  const caps = props.caps.value;
  const s = summarize(caps);
  const shown = caps.filter((c) => filter === 'all' || reviewStateOf(c) === filter);

  return (
    <Section id="review-h" title="Review" lede="The rules XO found, with the evidence from your document. Nothing runs until you approve it.">
      {props.compilations.length > 1 ? (
        <div className="row">
          <label htmlFor="cmp-pick">Analysis</label>
          <select id="cmp-pick" value={compilation.compilationId} onChange={(e) => props.onPickCompilation(e.target.value)}>
            {props.compilations.map((c) => (
              <option key={c.compilationId} value={c.compilationId}>
                {formatWhen(c.createdAt)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="summary" role="group" aria-label="Review summary">
        <FilterChip current={filter} id="all" onSelect={setFilter} label="All" n={s.total} />
        <FilterChip current={filter} id="needs_attention" onSelect={setFilter} label="Needs more information" n={s.needsAttention} />
        <FilterChip current={filter} id="ready_for_review" onSelect={setFilter} label="Ready for review" n={s.readyForReview} />
        <FilterChip current={filter} id="approved" onSelect={setFilter} label="Approved" n={s.approved} />
      </div>

      <p className="notice notice-info small">
        Approving records that you checked a rule against your document. It does not run anything. Independent sign-off and fine-grained permissions are not enforced by the platform yet, so treat approvals as recorded acknowledgements.
      </p>

      {caps.length === 0 ? <EmptyState title="XO did not find any rules in this document">Try a document that states rules, obligations or conditions.</EmptyState> : null}
      <ul className="list">
        {shown.map((c) => (
          <CapabilityCard key={c.capabilityId} workspaceId={props.workspaceId} compilationId={compilation.compilationId} capability={c} lastExecution={latest.get(c.capabilityId)} onChanged={props.onChanged} />
        ))}
      </ul>
    </Section>
  );
}

function FilterChip(props: { current: Filter; id: Filter; label: string; n: number; onSelect: (f: Filter) => void }) {
  return (
    <button type="button" className="chip" aria-pressed={props.current === props.id} onClick={() => props.onSelect(props.id)}>
      {props.label} <span className="chip-n">{props.n}</span>
    </button>
  );
}

function CapabilityCard(props: { workspaceId: string; compilationId: string; capability: Capability; lastExecution: Execution | undefined; onChanged: () => void }) {
  const { client, mode } = useSession();
  const c = props.capability;
  const state = reviewStateOf(c);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const classLabel = executionClassLabel(c.executionClass);

  async function approve() {
    setApproving(true);
    setProblem(undefined);
    const r = await client.approveCapability(props.workspaceId, props.compilationId, c.capabilityId);
    setApproving(false);
    setConfirming(false);
    if (r.ok) props.onChanged();
    else setProblem(r.problem);
  }

  const pages = c.provenance.flatMap((p) => p.pages ?? []);
  const uniquePages = [...new Set(pages)].sort((a, b) => a - b);

  return (
    <li className="card capability" data-state={state}>
      <div className="card-main">
        <div className="row between">
          <h3>{c.name}</h3>
          <Badge tone={TONE[state]}>{REVIEW_STATE_LABEL[state]}</Badge>
        </div>
        <blockquote className="evidence">
          <span className="evidence-label">What your document says{uniquePages.length > 0 ? ` · page ${uniquePages.join(', ')}` : ''}</span>
          {c.description}
        </blockquote>
        <p className="muted small">{REVIEW_STATE_EXPLANATION[state]}</p>
        <p className="muted small">
          {classLabel !== undefined ? `${classLabel} · ` : ''}XO&rsquo;s own confidence: {Math.round(c.confidence * 100)}% (an estimate, not independently verified)
        </p>
        {state === 'needs_attention' && mode === 'builder' && c.reason !== undefined ? <p className="mono small">{c.status}: {c.reason}</p> : null}
        {mode === 'builder' ? <p className="mono small">{c.capabilityId}{c.executionClass !== undefined ? ` · ${c.executionClass}` : ''}{c.declaredConfidence !== undefined ? ` · confidence basis: ${c.declaredConfidence.basis}` : ''}</p> : null}
        {props.lastExecution !== undefined ? <ExecutionOutcome workspaceId={props.workspaceId} execution={props.lastExecution} onChanged={props.onChanged} /> : null}
        {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
        {running && canRun(c) ? (
          <RunPanel
            workspaceId={props.workspaceId}
            compilationId={props.compilationId}
            capabilityId={c.capabilityId}
            lastExecution={props.lastExecution}
            onRan={() => {
              setRunning(false);
              props.onChanged();
            }}
          />
        ) : null}
        {mode === 'builder' ? (
          <details>
            <summary>Capability record</summary>
            <pre className="code">{JSON.stringify(c, null, 2)}</pre>
          </details>
        ) : null}
      </div>
      <div className="card-actions">
        {canApprove(c) && !confirming ? (
          <Button variant="primary" onClick={() => setConfirming(true)}>
            Approve
          </Button>
        ) : null}
        {confirming ? (
          <div className="confirm" role="group" aria-label={`Confirm approval of ${c.name}`}>
            <p className="small">Approve “{c.name}”? This records your approval. Nothing is run.</p>
            <div className="row">
              <Button variant="primary" disabled={approving} onClick={() => void approve()}>
                {approving ? 'Approving…' : 'Confirm approval'}
              </Button>
              <Button variant="quiet" disabled={approving} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {canRun(c) && !running ? (
          <Button variant="secondary" onClick={() => setRunning(true)}>
            Run…
          </Button>
        ) : null}
        {running ? (
          <Button variant="quiet" onClick={() => setRunning(false)}>
            Close
          </Button>
        ) : null}
      </div>
    </li>
  );
}

import { approvalWords, decidedByWords, effectStateWords, manifestWords, matchWords } from '../domain/evidence';
import { loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

/**
 * UW-12b (ADR 0052): why XO did this. Where each result came from (the row and, when there is one, the document and how it was
 * matched), who approved it, who decided each step, what was sent, and whether the workflow was the one that was certified.
 * Recipients and cell values are not shown here: the platform does not send them; actions show the connector, operation and
 * the number of values, which is what the approval covered.
 */
export function EvidenceView(props: { workspaceId: string; definitionId: string; runId: string; item?: number }) {
  const { client } = useSession();
  const load = useLoad(
    () => client.runEvidence(props.workspaceId, props.definitionId, props.runId, props.item),
    [client, props.workspaceId, props.definitionId, props.runId, props.item],
  );
  const e = loadedValue(load.state);
  if (load.state.phase === 'error' && e === undefined) return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  if (e === undefined) return <Skeleton label="Loading the evidence" />;
  const approval = approvalWords(e);
  return (
    <section className="ib-card evidence" aria-label="Why XO did this">
      <h3 className="cc-lead">Why XO did this</h3>
      {e.source !== undefined ? (
        <p className="small" aria-label="Where it came from">
          From {e.source.label}, row {e.source.row} of {e.source.connectionName}
          {e.source.document !== undefined ? `, with the document ${e.source.document.name}` : ''} ({matchWords(e.source.match)}).
        </p>
      ) : null}
      {approval !== undefined ? (
        <p className="small">{approval}</p>
      ) : (
        <p className="small">No batch or standing approval covers this run.</p>
      )}
      {e.steps.length > 0 ? (
        <ul className="cc-args" aria-label="Who decided each step">
          {e.steps.map((s) => (
            <li key={s.step}>
              {s.step}: {decidedByWords(s)}
              {s.outcome !== '' ? ` (${s.outcome})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {e.actions.length > 0 ? (
        <ul className="cc-args" aria-label="What it did">
          {e.actions.map((a) => (
            <li key={`${a.step}-${a.operation}`}>
              {a.connector} {a.operation} ({a.sideEffect}): {effectStateWords(a.state)}
            </li>
          ))}
        </ul>
      ) : null}
      <p className={e.manifest.digestOk ? 'muted small' : 'notice notice-danger small'}>{manifestWords(e)}</p>
    </section>
  );
}

import type { Progress, ReviewSummary } from '../domain/review';
import type { StartTarget } from '../domain/start';
import type { Compilation } from '../platform/wire';
import { Badge, EmptyState, formatWhen, Section } from './primitives';
import { UNAVAILABLE_TOOLS } from './PlatformSection';

type StepState = 'done' | 'current' | 'todo' | 'unavailable';

/**
 * Builder Mode: creating an XO from your own documents. The first three steps are the real Studio flow and their state is
 * derived from workspace facts; publishing and the registry are shown as unavailable with the platform's actual reason.
 */
export function XosSection(props: {
  analyses: readonly Compilation[];
  sourceCount: number;
  summary: ReviewSummary | undefined;
  next: Progress;
  goTo: (target: StartTarget) => void;
}) {
  const hasDocs = props.sourceCount > 0;
  const analysed = props.analyses.length > 0;
  const reviewed = (props.summary?.approved ?? 0) > 0;
  const steps: { key: string; title: string; detail: string; state: StepState; target?: StartTarget; action?: string }[] = [
    {
      key: 'docs',
      title: 'Add documents',
      detail: 'Policies, procedures and rulebooks your XO is built from.',
      state: hasDocs ? 'done' : 'current',
      target: 'documents',
      action: 'Open Sources',
    },
    {
      key: 'analyse',
      title: 'Analyse',
      detail: 'XO reads them and finds the rules inside.',
      state: analysed ? 'done' : hasDocs ? 'current' : 'todo',
      target: 'documents',
      action: 'Open Sources',
    },
    {
      key: 'review',
      title: 'Review rules',
      detail: 'You approve every rule before a process may use it.',
      state: reviewed ? 'done' : analysed ? 'current' : 'todo',
      target: 'rules',
      action: 'Review rules',
    },
    { key: 'publish', title: 'Publish', detail: UNAVAILABLE_TOOLS[1]?.reason ?? 'Not available yet.', state: 'unavailable' },
  ];
  return (
    <Section
      id="xos-h"
      title="XOs"
      lede="Build an XO from your own documents. Publishing and the registry are not available in Studio yet."
    >
      <ol className="plain xo-steps" aria-label="Create an XO">
        {steps.map((s, i) => (
          <li key={s.key} className="xo-step" data-state={s.state}>
            <span className="gs-dot" aria-hidden="true">
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            <div className="xo-step-main">
              <p className="gs-title">
                {s.title}
                {s.state === 'unavailable' ? <Badge tone="neutral">Not available yet</Badge> : null}
              </p>
              <p className="muted small">{s.detail}</p>
              {s.target !== undefined && s.state === 'current' ? (
                <button type="button" className="crumb-link" onClick={() => props.goTo(s.target!)}>
                  {s.action}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <h3 className="subhead">Your analyses</h3>
      {props.analyses.length === 0 ? (
        <EmptyState title="No analyses yet">{props.next.hint}</EmptyState>
      ) : (
        <ul className="list">
          {[...props.analyses]
            .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))
            .map((c) => (
              <li key={c.compilationId} className="card">
                <div className="card-main">
                  <h3>Analysis of your documents</h3>
                  <p className="muted small">Finished {formatWhen(c.completedAt ?? c.createdAt)}</p>
                </div>
                <Badge tone="success">Succeeded</Badge>
              </li>
            ))}
        </ul>
      )}
      <h3 className="subhead">Registry</h3>
      <EmptyState title="Browsing and installing XOs is not available yet">{UNAVAILABLE_TOOLS[1]?.reason}</EmptyState>
    </Section>
  );
}

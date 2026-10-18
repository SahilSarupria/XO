import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, ProblemNotice, Section, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

/**
 * What Builder Mode cannot do yet, and the actual reason. Each line states whether the platform offers the
 * operation at all, so a missing tool is never mistaken for a missing permission.
 */
export const UNAVAILABLE_TOOLS: readonly { readonly title: string; readonly reason: string }[] = [
  {
    title: 'XOIR and knowledge or capability graph viewer',
    reason:
      'The platform can compile input into XOIR, but it has no read endpoint that returns the XOIR or graph behind your documents, so there is nothing for Studio to display.',
  },
  {
    title: 'Building and publishing a custom XO',
    reason: 'The platform has package validation and registry endpoints, but Studio has no support for them yet.',
  },
  {
    title: 'Runtime context and AI-assisted execution',
    reason:
      'Studio does not call the runtime context endpoint. AI-assisted execution is switched off by the platform itself. Processes run through Workflows instead.',
  },
  {
    title: 'Editing or composing workflows',
    reason: 'The platform composes processes from discovered rules. Studio can inspect and start them, not change them.',
  },
];

/**
 * Builder Mode, read-only: whether the platform answers, the platform's own description of its API, and an honest
 * list of what Studio cannot do yet. Both requests go to routes the platform serves publicly; neither changes anything.
 */
export function PlatformSection() {
  const { client } = useSession();
  const health = useLoad(() => client.getHealth(), [client]);
  const api = useLoad(() => client.getApiDescription(), [client]);
  const [query, setQuery] = useState('');
  const ops = api.state.phase === 'ready' ? api.state.value.operations : undefined;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (ops === undefined) return [];
    return q === '' ? ops : ops.filter((o) => `${o.method} ${o.path} ${o.summary ?? ''}`.toLowerCase().includes(q));
  }, [ops, query]);

  return (
    <Section
      id="platform-h"
      title="Platform"
      lede="Whether the XO service is reachable, what its API offers, and what Studio cannot do with it yet."
    >
      <section className="card" aria-labelledby="health-h">
        <div className="card-main">
          <h3 id="health-h">Service status</h3>
          {health.state.phase === 'loading' ? <Skeleton label="Checking the service" rows={1} /> : null}
          {health.state.phase === 'ready' ? (
            <p role="status">
              <Badge tone={health.state.value.status === 'ok' ? 'success' : 'warning'}>{health.state.value.status}</Badge>{' '}
              <span className="muted small">The service answered the health check.</span>
            </p>
          ) : null}
          {health.state.phase === 'error' ? <ProblemNotice problem={health.state.problem} onRetry={health.reload} /> : null}
        </div>
      </section>

      <section className="stack" aria-labelledby="api-h">
        <h3 id="api-h">API reference</h3>
        {api.state.phase === 'loading' ? <Skeleton label="Loading the API description" /> : null}
        {api.state.phase === 'error' ? <ProblemNotice problem={api.state.problem} onRetry={api.reload} /> : null}
        {api.state.phase === 'ready' ? (
          <>
            <p className="muted small">
              {api.state.value.title} · version {api.state.value.version} · {api.state.value.operations.length} operations, as the platform
              describes itself. Studio shows this; it does not call these operations from here.
            </p>
            <div className="field">
              <label htmlFor="api-filter">Filter operations</label>
              <input id="api-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {shown.length === 0 ? (
              <EmptyState title="No operations match">Try a different word.</EmptyState>
            ) : (
              <>
                <p className="scroll-hint muted small">Swipe sideways to see every column.</p>
                <div className="table-scroll" tabIndex={0} role="region" aria-label="API operations, scrolls sideways">
                  <table className="table">
                    <caption className="visually-hidden">Platform API operations</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="nowrap">
                          Method
                        </th>
                        <th scope="col">Path</th>
                        <th scope="col">What it does</th>
                        <th scope="col" className="nowrap">
                          Access
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((o) => (
                        <tr key={`${o.method} ${o.path}`}>
                          <td className="mono nowrap">{o.method}</td>
                          <td className="mono wrap">{o.path}</td>
                          <td className="wrap">{o.summary ?? ''}</td>
                          <td className="nowrap">{o.requiresAuth ? 'Needs a key' : 'Open'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <Button variant="quiet" onClick={api.reload}>
              Reload
            </Button>
          </>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="unavailable-h">
        <h3 id="unavailable-h">Not available in Studio yet</h3>
        <ul className="plain stack" aria-label="Not available in Studio yet">
          {UNAVAILABLE_TOOLS.map((t) => (
            <li key={t.title} className="small">
              <strong>{t.title}</strong> <span className="muted">— {t.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </Section>
  );
}

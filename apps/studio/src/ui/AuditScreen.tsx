import { useEffect, useState } from 'react';
import { can, whyNot } from '../domain/access';
import { downloadText } from '../domain/download';
import type { ApiProblem } from '../platform/client';
import type { Workspace } from '../platform/wire';
import type { AuditEntry, AuditResult } from '../platform/wire-studio';
import { Badge, Button, EmptyState, formatWhen, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

const RESULT: Record<AuditResult, { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  succeeded: { text: 'Completed', tone: 'success' },
  approved: { text: 'Approved', tone: 'success' },
  failed: { text: 'Failed', tone: 'danger' },
  denied: { text: 'Denied', tone: 'danger' },
  rejected: { text: 'Rejected', tone: 'danger' },
  escalated: { text: 'Escalated', tone: 'warning' },
};

const EVENT: Record<string, string> = {
  'workspace.created': 'Created workspace',
  'workspace.updated': 'Updated workspace',
  'member.added': 'Added a member',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed a member',
  'settings.updated': 'Changed settings',
  'source.uploaded': 'Uploaded a document',
  'source.imported': 'Imported a document from a link',
  'source.deleted': 'Deleted a document',
  'compilation.started': 'Analysed a document',
  'capability.approved': 'Approved a capability',
  'execution.created': 'Ran a capability',
  'execution.test_run': 'Test run',
  'human_task.resolved': 'Decided a review',
  'human_task.info_requested': 'Asked for more information',
  'workflow.started': 'Started a process',
  'workflow.resumed': 'Resumed a process',
  'workflow.definition_saved': 'Saved a workflow draft',
  'workflow.definition_deleted': 'Deleted a workflow draft',
  'xo.published': 'Published an XO',
  'xo.installed': 'Installed an XO',
  'xo.uninstalled': 'Uninstalled an XO',
  'chat.message': 'Chatted with Ask XO',
  'access.denied': 'Was refused',
  'audit.exported': 'Exported the audit log',
};
const RUN_EVENTS = new Set(['execution.created', 'execution.test_run', 'workflow.started', 'workflow.resumed', 'compilation.started']);

type Filter = 'all' | 'publishing' | 'denied' | 'runs';
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All events' },
  { id: 'publishing', label: 'Publishing' },
  { id: 'denied', label: 'Access denied' },
  { id: 'runs', label: 'Runs' },
];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Audit log, read from the platform's own audit log: append-only and hash-chained. That makes edits, removals and
 * reordering DETECTABLE (the Integrity card re-checks the chain on demand). It does not stop someone with write access
 * to the server's storage from rewriting the whole chain, and Studio says so. Retention is whatever the operator
 * declared; if nothing was declared the card says so rather than showing a period. The export is evidence for a review,
 * not a compliance certificate.
 */
export function AuditScreen(props: { workspace: Workspace; onManageMembers: () => void }) {
  const { client } = useSession();
  const ws = props.workspace.workspaceId;
  const role = props.workspace.role;
  const allowed = can(role, 'audit');
  const [filter, setFilter] = useState<Filter>('all');
  const [recent, setRecent] = useState(false);
  const [since, setSince] = useState<string | undefined>();
  useEffect(() => setSince(recent ? new Date(Date.now() - SEVEN_DAYS_MS).toISOString() : undefined), [recent]);

  const server = {
    ...(filter === 'publishing' ? { event: 'xo.published' } : {}),
    ...(filter === 'denied' ? { event: 'access.denied' } : {}),
    ...(since !== undefined ? { since } : {}),
    limit: 50,
  };
  const first = useLoad(
    () => (allowed ? client.listAudit(ws, server) : Promise.resolve({ ok: true as const, value: { events: [] } })),
    [client, ws, allowed, filter, since],
  );
  const [more, setMore] = useState<readonly AuditEntry[]>([]);
  const [next, setNext] = useState<number | undefined>();
  const [moreProblem, setMoreProblem] = useState<ApiProblem | undefined>();
  const firstPage = loadedValue(first.state);
  useEffect(() => {
    setMore([]);
    setNext(firstPage?.nextBefore);
  }, [firstPage]);

  async function loadMore() {
    if (next === undefined) return;
    setMoreProblem(undefined);
    const r = await client.listAudit(ws, { ...server, before: next });
    if (!r.ok) return setMoreProblem(r.problem);
    setMore((m) => [...m, ...r.value.events]);
    setNext(r.value.nextBefore);
  }

  const events = [...(firstPage?.events ?? []), ...more].filter((e) => (filter === 'runs' ? RUN_EVENTS.has(e.event) : true));

  return (
    <section className="section" aria-labelledby="audit-h">
      <header className="section-head">
        <h2 id="audit-h">Audit log</h2>
        <ExportButtons workspace={props.workspace} />
      </header>
      {!allowed ? (
        <EmptyState title="The audit log is not available to your role">{whyNot(role, 'audit', 'reading the audit log')}</EmptyState>
      ) : (
        <>
          <div className="chips-row" role="group" aria-label="Filter events">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={recent} onClick={() => setRecent((r) => !r)}>
              Last 7 days
            </button>
          </div>
          {filter === 'runs' ? (
            <p className="muted small">Showing run events from the entries loaded so far. Load more to look further back.</p>
          ) : null}
          <div className="audit-grid">
            <div>
              {first.state.phase === 'loading' ? <Skeleton label="Loading the audit log" rows={5} /> : null}
              {first.state.phase === 'error' ? <ProblemNotice problem={first.state.problem} onRetry={first.reload} /> : null}
              {firstPage !== undefined ? (
                <div className="table" role="table" aria-label="Audit events">
                  <div className="table-head" role="row">
                    <span role="columnheader">Time</span>
                    <span role="columnheader">Who</span>
                    <span role="columnheader">Event</span>
                    <span role="columnheader">Target</span>
                    <span role="columnheader">Result</span>
                  </div>
                  {events.length === 0 ? <p className="muted small table-empty">No events match.</p> : null}
                  {events.map((e) => {
                    const res = RESULT[e.result];
                    return (
                      <div key={e.seq} className="table-row" role="row">
                        <span role="cell" className="mono muted small">
                          {formatWhen(e.at)}
                        </span>
                        <span role="cell">
                          {e.actor.displayName ?? e.actor.identityId}
                          {e.actor.role !== undefined ? <span className="muted small"> · {e.actor.role}</span> : null}
                        </span>
                        <span role="cell">{EVENT[e.event] ?? e.event}</span>
                        <span role="cell" className="mono small">
                          {e.target?.label ?? e.target?.id ?? '—'}
                        </span>
                        <span role="cell">
                          <Badge tone={res.tone}>{res.text}</Badge>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {moreProblem !== undefined ? <ProblemNotice problem={moreProblem} onRetry={() => void loadMore()} /> : null}
              {next !== undefined ? (
                <Button variant="secondary" onClick={() => void loadMore()}>
                  Load older events
                </Button>
              ) : null}
            </div>
            <aside className="audit-side" aria-label="Roles and integrity">
              <RolesCard workspaceId={ws} onManage={props.onManageMembers} />
              <IntegrityCard workspaceId={ws} />
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

function ExportButtons(props: { workspace: Workspace }) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const allowed = can(props.workspace.role, 'manage');
  async function run(format: 'json' | 'csv') {
    setBusy(true);
    setProblem(undefined);
    const r = await client.exportAudit(props.workspace.workspaceId, format);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    downloadText(`audit-${props.workspace.workspaceId}.${format}`, r.value, format === 'json' ? 'application/json' : 'text/csv');
  }
  return (
    <div className="section-actions">
      <Button
        variant="secondary"
        disabled={!allowed || busy}
        title={
          allowed
            ? 'Evidence for a review. Not a compliance certificate.'
            : whyNot(props.workspace.role, 'manage', 'exporting the audit log')
        }
        onClick={() => void run('json')}
      >
        Export evidence (JSON)
      </Button>
      <Button
        variant="quiet"
        disabled={!allowed || busy}
        title={allowed ? undefined : whyNot(props.workspace.role, 'manage', 'exporting the audit log')}
        onClick={() => void run('csv')}
      >
        CSV
      </Button>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </div>
  );
}

function RolesCard(props: { workspaceId: string; onManage: () => void }) {
  const { client } = useSession();
  const members = useLoad(() => client.listMembers(props.workspaceId), [client, props.workspaceId]);
  const list = loadedValue(members.state);
  return (
    <section className="xoi-card" aria-labelledby="roles-h">
      <h3 id="roles-h">Roles</h3>
      {members.state.phase === 'loading' ? <Skeleton label="Loading roles" rows={2} /> : null}
      {members.state.phase === 'error' ? <ProblemNotice problem={members.state.problem} onRetry={members.reload} /> : null}
      {list !== undefined ? (
        <ul className="bare-list audit-roles">
          {(['admin', 'publisher', 'reviewer', 'viewer'] as const).map((r) => (
            <li key={r} className="row between">
              <span>{r[0]!.toUpperCase() + r.slice(1)}</span>
              <span className="mono">{list.roleCounts[r]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="quiet" onClick={props.onManage}>
        Manage members
      </Button>
    </section>
  );
}

function IntegrityCard(props: { workspaceId: string }) {
  const { client } = useSession();
  const verification = useLoad(() => client.verifyAudit(props.workspaceId), [client, props.workspaceId]);
  const v = loadedValue(verification.state);
  return (
    <section className="xoi-card" aria-labelledby="integ-h">
      <div className="row between">
        <h3 id="integ-h">Integrity</h3>
        {v !== undefined ? <Badge tone={v.ok ? 'success' : 'danger'}>{v.ok ? 'Chain intact' : 'Chain broken'}</Badge> : null}
      </div>
      {verification.state.phase === 'loading' ? <Skeleton label="Checking the audit chain" rows={2} /> : null}
      {verification.state.phase === 'error' ? <ProblemNotice problem={verification.state.problem} onRetry={verification.reload} /> : null}
      {v !== undefined ? (
        <>
          <p className="small">
            {v.entries} {v.entries === 1 ? 'entry' : 'entries'} re-checked just now.
            {v.ok
              ? ''
              : ` The chain breaks at entry ${v.brokenAt?.seq ?? '?'} (${(v.brokenAt?.reason ?? 'unknown').replace(/_/g, ' ')}). Treat this log as tampered with and tell an administrator.`}
          </p>
          <p className="muted small">
            The log is append-only and each entry is chained to the one before, so an edit, removal or reordering is detectable. It cannot
            detect someone with access to the server&apos;s storage rewriting the whole chain consistently, so it is tamper-evident, not
            tamper-proof.
          </p>
          <p className="muted small">
            {v.retentionMinimumDays === null
              ? 'Retention: no policy has been declared by the operator, so none is stated here.'
              : `Retention: the operator declares at least ${v.retentionMinimumDays} days. The platform does not delete entries, but cannot guarantee its own storage.`}
          </p>
        </>
      ) : null}
      <Button variant="quiet" onClick={verification.reload}>
        Check again
      </Button>
    </section>
  );
}

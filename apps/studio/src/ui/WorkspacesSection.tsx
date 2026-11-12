import { roleLabel } from '../domain/access';
import type { Workspace } from '../platform/wire';
import { Badge, Button, EmptyState, formatWhen, Section } from './primitives';

/**
 * The person's workspaces, from the platform's own list. Choosing one is the same action as the sidebar
 * switcher; the API still decides which workspaces exist for this person (foreign ids are simply not listed).
 */
export function WorkspacesSection(props: {
  workspaces: readonly Workspace[];
  activeId: string;
  onSelect: (workspaceId: string) => void;
  onNew: () => void;
}) {
  return (
    <Section
      id="workspaces-h"
      title="Workspaces"
      lede="Each workspace holds one body of documents and the processes found in them."
      actions={
        <Button variant="secondary" onClick={props.onNew}>
          New workspace
        </Button>
      }
    >
      {props.workspaces.length === 0 ? (
        <EmptyState title="No workspaces yet">Create a workspace to start adding documents.</EmptyState>
      ) : (
        <ul className="plain stack" aria-label="Your workspaces">
          {props.workspaces.map((w) => {
            const active = w.workspaceId === props.activeId;
            const name = w.name ?? 'Untitled workspace';
            return (
              <li key={w.workspaceId} className="card">
                <div className="card-main">
                  <div className="row between">
                    <h3>{name}</h3>
                    {active ? <Badge tone="accent">Current</Badge> : null}
                  </div>
                  <p className="muted small">Created {formatWhen(w.createdAt)}</p>
                  <dl className="muted small" aria-label={`${name} details`}>
                    {w.kind !== undefined ? <WsFact label="Type" value={w.kind === 'personal' ? 'Personal (one person)' : 'Team'} /> : null}
                    {w.region !== undefined || w.regionLabel !== undefined ? (
                      <WsFact label="Declared region" value={w.regionLabel ?? w.region ?? ''} />
                    ) : null}
                    {w.memberCount !== undefined ? <WsFact label="Members" value={String(w.memberCount)} /> : null}
                    {w.role !== undefined ? <WsFact label="Your role" value={roleLabel(w.role)} /> : null}
                  </dl>
                  {!active ? (
                    <div className="row">
                      <Button variant="secondary" aria-label={`Open ${name}`} onClick={() => props.onSelect(w.workspaceId)}>
                        Open
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function WsFact(props: { label: string; value: string }) {
  return (
    <div className="row">
      <dt>{props.label}:</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

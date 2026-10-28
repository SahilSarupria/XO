import { useEffect, useRef } from 'react';
import type { Capability, Workflow, WorkspaceRole } from '../platform/wire';
import { CapabilityTestPanel } from './CapabilityTestPanel';
import { Badge, Button, EmptyState, loadedValue, Section, Skeleton, type LoadState } from './primitives';

const STATUS_TONE: Record<Capability['status'], 'success' | 'warning' | 'danger'> = {
  resolved: 'success',
  unresolved: 'warning',
  ambiguous: 'warning',
  denied: 'danger',
};

/**
 * Builder Mode: the rules XO found, as the platform published them. Nothing here is computed by Studio: binding
 * status, execution class, input contract and provenance are shown as reported. A missing input contract is shown
 * as "not published", never as "no input needed". Reuses the capabilities already loaded for the workspace.
 */
export function ContractsSection(props: {
  caps: LoadState<Capability[]>;
  workspaceId: string;
  /** The compilation these capabilities belong to; Preview and Test Run need it. */
  compilationId: string | undefined;
  role: WorkspaceRole | undefined;
  onChanged: () => void;
  workflows: readonly Workflow[];
  /** A capability another Builder screen asked to look at (opened and scrolled into view). */
  focus: string | undefined;
  goToSources: () => void;
  goToProcesses: () => void;
}) {
  const list = loadedValue(props.caps);
  const usedBy = (id: string) => props.workflows.filter((w) => w.steps.some((s) => s.capabilityId === id)).length;
  const counts = (list ?? []).reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});

  return (
    <Section
      id="contracts-h"
      title="Contracts"
      lede="What the platform published for each rule XO found: how it binds, what input it needs, and where it came from."
    >
      {props.caps.phase === 'loading' ? <Skeleton label="Loading contracts" /> : null}
      {props.caps.phase === 'error' && list === undefined ? (
        <p className="muted small">Contracts could not be loaded. The notice above says why, and you can retry from there.</p>
      ) : null}
      {list !== undefined && list.length === 0 ? (
        <EmptyState title="No contracts yet">
          Contracts come from an analysed document.{' '}
          <button type="button" className="crumb-link" onClick={props.goToSources}>
            Go to Sources
          </button>
        </EmptyState>
      ) : null}
      {list !== undefined && list.length > 0 ? (
        <>
          <p className="muted small" role="status">
            {list.length} {list.length === 1 ? 'contract' : 'contracts'}
            {Object.entries(counts)
              .map(([k, n]) => ` · ${n} ${k}`)
              .join('')}
          </p>
          <ul className="list" aria-label="Capability contracts">
            {list.map((c) => (
              <ContractCard
                key={c.capabilityId}
                cap={c}
                used={usedBy(c.capabilityId)}
                focused={props.focus === c.capabilityId}
                goToProcesses={props.goToProcesses}
                test={
                  props.compilationId === undefined
                    ? undefined
                    : { workspaceId: props.workspaceId, compilationId: props.compilationId, role: props.role, onChanged: props.onChanged }
                }
              />
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

function ContractCard(props: {
  cap: Capability;
  used: number;
  focused: boolean;
  goToProcesses: () => void;
  test: { workspaceId: string; compilationId: string; role: WorkspaceRole | undefined; onChanged: () => void } | undefined;
}) {
  const c = props.cap;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (props.focused) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [props.focused]);
  const props_ = c.inputContract === undefined ? undefined : Object.entries(c.inputContract.properties);
  return (
    <li ref={ref} id={`contract-${c.capabilityId}`} className="card" data-focused={props.focused ? 'true' : undefined}>
      <div className="card-main">
        <div className="row between">
          <h3>{c.name}</h3>
          <span className="row">
            <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
            {c.approved ? <Badge tone="success">approved</Badge> : <Badge tone="neutral">not approved</Badge>}
          </span>
        </div>
        <p className="mono small">
          {c.capabilityId}
          {c.contractId !== c.capabilityId ? ` · contract ${c.contractId}` : ''}
          {c.executionClass !== undefined ? ` · ${c.executionClass}` : ''} · confidence {Math.round(c.confidence * 100)}%
          {c.declaredConfidence !== undefined ? ` (${c.declaredConfidence.basis})` : ''}
        </p>
        {c.reason !== undefined ? <p className="mono small">{c.reason}</p> : null}
        <details open={props.focused}>
          <summary>Input contract</summary>
          {props_ === undefined ? (
            <p className="muted small">No input contract was published. That does not mean no input is needed.</p>
          ) : props_.length === 0 ? (
            <p className="muted small">The contract declares no inputs.</p>
          ) : (
            <>
              <p className="scroll-hint muted small">Swipe sideways to see every column.</p>
              <div className="table-scroll" tabIndex={0} role="region" aria-label={`Inputs for ${c.name}, scrolls sideways`}>
                <table className="table">
                  <caption className="visually-hidden">Inputs for {c.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Input</th>
                      <th scope="col">Type</th>
                      <th scope="col">Required</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props_.map(([name, def]) => (
                      <tr key={name}>
                        <th scope="row" className="mono">
                          {name}
                        </th>
                        <td className="mono">{def.type}</td>
                        <td>{c.inputContract?.required.includes(name) ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </details>
        <details>
          <summary>Where it came from ({c.provenance.length})</summary>
          {c.provenance.length === 0 ? (
            <p className="muted small">The platform reported no provenance for this rule.</p>
          ) : (
            <ul className="plain">
              {c.provenance.map((p, i) => (
                <li key={i} className="mono small">
                  {p.documentPath}
                  {p.locator !== undefined ? ` · ${p.locator}` : ''}
                  {p.pages !== undefined && p.pages.length > 0 ? ` · page ${p.pages.join(', ')}` : ''}
                </li>
              ))}
            </ul>
          )}
        </details>
        <div className="row">
          {props.used > 0 ? (
            <Button variant="quiet" onClick={props.goToProcesses}>
              View the {props.used} {props.used === 1 ? 'process' : 'processes'} using this
            </Button>
          ) : (
            <span className="muted small">Not used in any process yet.</span>
          )}
        </div>
        {props.test !== undefined ? (
          <details>
            <summary>Preview and Test Run</summary>
            <CapabilityTestPanel cap={c} {...props.test} />
          </details>
        ) : null}
        <details>
          <summary>Capability record</summary>
          <pre className="code" tabIndex={0} aria-label={`Raw record for ${c.name}`}>
            {JSON.stringify(c, null, 2)}
          </pre>
        </details>
      </div>
    </li>
  );
}

import { useState } from 'react';
import type { Workspace } from '../platform/wire';
import '../styles/choose-workspace.css';

const created = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/**
 * "Choose a workspace", per the XO Studio desktop design. Shown when the person can open more than one
 * workspace. Everything listed comes from the platform's workspace list; the design's team size, region and
 * "works offline" lines are not part of that list, so they are not shown (nothing is invented).
 */
export function ChooseWorkspace(props: {
  workspaces: readonly Workspace[];
  onOpen: (workspaceId: string) => void;
  onCreate: () => void;
  onSwitchAccount: () => void;
}) {
  const [picked, setPicked] = useState<string | undefined>(props.workspaces[0]?.workspaceId);
  const selected = props.workspaces.find((w) => w.workspaceId === picked) ?? props.workspaces[0];

  return (
    <main className="cw" aria-labelledby="cw-title">
      <div className="cw-panel">
        <p className="cw-brand">
          <span className="cw-mark" aria-hidden="true" />
          XO Studio
        </p>
        <h1 id="cw-title">Choose a workspace</h1>
        <p className="cw-sub">
          Signed in ·{' '}
          <button type="button" className="cw-link" onClick={props.onSwitchAccount}>
            Switch account
          </button>
        </p>
        <div className="cw-list" role="radiogroup" aria-label="Your workspaces">
          {props.workspaces.map((w) => {
            const checked = w.workspaceId === selected?.workspaceId;
            return (
              <button
                key={w.workspaceId}
                type="button"
                role="radio"
                aria-checked={checked}
                className="cw-option"
                onClick={() => setPicked(w.workspaceId)}
              >
                <span className="cw-tile" aria-hidden="true" />
                <span className="cw-text">
                  <span className="cw-name">{w.name ?? 'Untitled workspace'}</span>
                  <span className="cw-meta">Created {created(w.createdAt)}</span>
                </span>
                {checked ? (
                  <svg className="cw-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="cw-actions">
          <button type="button" className="cw-dashed" onClick={props.onCreate}>
            + Create workspace
          </button>
        </div>
        <button
          type="button"
          className="cw-open"
          disabled={selected === undefined}
          onClick={() => selected && props.onOpen(selected.workspaceId)}
        >
          Open workspace
        </button>
      </div>
    </main>
  );
}

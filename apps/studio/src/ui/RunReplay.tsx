import { useEffect, useId, useState } from 'react';
import { replayFrame } from '../domain/replay';
import type { WorkflowRun } from '../platform/wire';
import { Button } from './primitives';

export const REPLAY_STATE_LABEL = {
  upcoming: 'Not reached yet',
  done: 'Finished',
  waiting: 'Waiting',
  failed: 'Did not complete',
  skipped: 'Skipped',
} as const;

/** Play / pause, a slider and the caption for a replay. The position itself belongs to the caller so a graph can follow it. */
export function ReplayControls(props: { total: number; position: number; onPosition: (p: number) => void; caption: string }) {
  const { total, position, onPosition } = props;
  const [playing, setPlaying] = useState(false);
  const sliderId = useId();

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (position + 1 >= total) setPlaying(false);
      onPosition(Math.min(position + 1, total));
    }, 800);
    return () => clearInterval(t);
  }, [playing, position, total, onPosition]);

  return (
    <>
      <div className="row replay-controls">
        <Button
          variant="secondary"
          onClick={() => {
            if (position >= total) onPosition(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <label htmlFor={sliderId} className="visually-hidden">
          Replay position
        </label>
        <input
          id={sliderId}
          className="replay-slider"
          type="range"
          min={0}
          max={total}
          value={position}
          onChange={(e) => {
            setPlaying(false);
            onPosition(Number(e.target.value));
          }}
        />
      </div>
      <p className="small" role="status">
        {props.caption}
      </p>
    </>
  );
}

/** Read-only picture of a run's steps in the order they ran, with a slider to step through them. */
export function RunReplay(props: { run: WorkflowRun }) {
  const total = props.run.steps.length;
  const [position, setPosition] = useState(0);
  const { nodes, caption } = replayFrame(props.run, position);
  return (
    <div className="replay">
      <ol className="stepgraph" aria-label="Steps in the order they ran">
        {nodes.map((n) => (
          <li
            key={n.stepId}
            className="stepnode"
            data-state={n.state}
            data-current={n.current}
            aria-current={n.current ? 'step' : undefined}
          >
            <span className="stepnode-name">{n.name}</span>
            <span className="stepnode-state">{REPLAY_STATE_LABEL[n.state]}</span>
          </li>
        ))}
      </ol>
      <ReplayControls total={total} position={position} onPosition={setPosition} caption={caption} />
      {nodes.find((n) => n.current)?.errorMessage ? (
        <p className="notice notice-danger small">{nodes.find((n) => n.current)?.errorMessage}</p>
      ) : null}
      <p className="muted small">XO records the order and outcome of each step, not how long it took.</p>
    </div>
  );
}

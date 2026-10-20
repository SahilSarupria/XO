import { useEffect, useId, useState } from 'react';
import { replayFrame } from '../domain/replay';
import type { WorkflowRun } from '../platform/wire';
import { Button } from './primitives';

const STATE_LABEL = {
  upcoming: 'Not reached yet',
  done: 'Finished',
  waiting: 'Waiting',
  failed: 'Did not complete',
  skipped: 'Skipped',
} as const;

/** Read-only picture of a run's steps in the order they ran, with a slider to step through them. */
export function RunReplay(props: { run: WorkflowRun }) {
  const total = props.run.steps.length;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const sliderId = useId();

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setPosition((p) => {
        if (p + 1 >= total) setPlaying(false);
        return Math.min(p + 1, total);
      });
    }, 800);
    return () => clearInterval(t);
  }, [playing, total]);

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
            <span className="stepnode-state">{STATE_LABEL[n.state]}</span>
          </li>
        ))}
      </ol>
      <div className="row replay-controls">
        <Button
          variant="secondary"
          onClick={() => {
            if (position >= total) setPosition(0);
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
            setPosition(Number(e.target.value));
          }}
        />
      </div>
      <p className="small" role="status">
        {caption}
      </p>
      {nodes.find((n) => n.current)?.errorMessage ? (
        <p className="notice notice-danger small">{nodes.find((n) => n.current)?.errorMessage}</p>
      ) : null}
      <p className="muted small">XO records the order and outcome of each step, not how long it took.</p>
    </div>
  );
}

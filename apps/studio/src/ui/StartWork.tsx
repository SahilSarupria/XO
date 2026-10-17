import type { StartAction, StartTarget } from '../domain/start';
import { Button } from './primitives';

/**
 * The entry point to real work. Every choice here is something XO can do today, derived from the workspace's
 * actual state (see domain/start.ts). There is deliberately no free-text box: XO has no task resolver, so asking
 * for one would imply a capability that does not exist. Choosing only navigates; XO's own screens do the rest,
 * and the API still decides what is permitted.
 */
export function StartWork(props: { actions: readonly StartAction[]; onChoose: (target: StartTarget) => void }) {
  const [recommended, ...others] = props.actions;
  if (recommended === undefined) return null;
  return (
    <section className="start" aria-labelledby="start-h">
      <div className="stack">
        <h3 id="start-h">Start work</h3>
        <p className="muted small">XO works from your documents and the rules you approve. Choose where to begin.</p>
      </div>
      <div className="start-primary">
        <p className="muted small">{recommended.detail}</p>
        <Button variant="primary" className="btn-lg" onClick={() => props.onChoose(recommended.target)}>
          {recommended.title}
        </Button>
      </div>
      {others.length > 0 ? (
        <ul className="plain start-others" aria-label="Other ways to start">
          {others.map((a) => (
            <li key={a.id}>
              <Button variant="secondary" onClick={() => props.onChoose(a.target)}>
                {a.title}
              </Button>
              <span className="muted small">{a.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted small">XO does not take free-text requests yet, so everything above is a step it can really carry out.</p>
    </section>
  );
}

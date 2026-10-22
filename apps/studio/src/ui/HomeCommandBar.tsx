import type { StartTarget } from '../domain/start';
import { AskDock, type DockProps } from './AskDock';

export interface HomeChip {
  readonly label: string;
  readonly target: StartTarget;
}

/**
 * The command bar at the top of Home. It is the same Ask XO bar as on every other screen: typing unfolds the conversation
 * out of it. The quick actions below are built from what this workspace actually holds.
 */
export function HomeCommandBar(props: { dock: DockProps; chips: readonly HomeChip[]; onChip?: (target: StartTarget) => void }) {
  return (
    <div className="cmd-wrap">
      <AskDock variant="home" {...props.dock} />
      <ul className="chips-row bare-list" aria-label="Quick actions">
        {props.chips.map((c) => (
          <li key={c.label}>
            <button type="button" className="chip" onClick={() => props.onChip?.(c.target)}>
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { ItemSourceView } from '../platform/wire-control';
import { Button } from './primitives';

/**
 * UW-12b (ADR 0052): more than one confirmed list could give a once-per-item process its items. XO does not pick between a
 * person's lists; the person says which, and only then is a preview prepared (nothing is sent either way).
 */
export function ItemSourcePicker(props: {
  sources: readonly ItemSourceView[] | undefined;
  onChoose: (s: ItemSourceView) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  if (props.sources === undefined) return null;
  return (
    <fieldset className="cc-steps" aria-label="Which list should it use">
      <legend className="small">Which list should it use?</legend>
      {props.sources.map((s) => (
        <div key={`${s.connectionId}:${s.proposalId}`} className="cc-step-choice">
          <p className="small">
            {s.label} in {s.connectionName} ({s.items} {s.items === 1 ? 'item' : 'items'}
            {s.excluded > 0 ? `, ${s.excluded} left out` : ''})
          </p>
          <Button onClick={() => props.onChoose(s)} disabled={props.disabled === true}>
            Use {s.label} in {s.connectionName}
          </Button>
        </div>
      ))}
      <Button variant="quiet" onClick={props.onCancel}>
        Not now
      </Button>
    </fieldset>
  );
}

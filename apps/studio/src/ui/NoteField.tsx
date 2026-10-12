import { useId } from 'react';
import { NOTE_MAX_CHARS, normalizeNote } from '../domain/work';

/**
 * An optional note on a decision. Collapsed by default so approving or rejecting never asks for text.
 * The note is sent to the platform with the decision and shown afterwards only from what the platform returns.
 */
export function NoteField(props: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  const { error } = normalizeNote(props.value);
  return (
    <details className="note" open={props.value.length > 0 ? true : undefined}>
      <summary>Add a note (optional)</summary>
      <label htmlFor={id} className="muted small">
        Saved with your decision.
      </label>
      <textarea
        id={id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        rows={3}
        disabled={props.disabled}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className={error !== undefined ? 'danger-text small' : 'muted small'}>
        {error ?? `${props.value.trim().length} / ${NOTE_MAX_CHARS}`}
      </p>
    </details>
  );
}

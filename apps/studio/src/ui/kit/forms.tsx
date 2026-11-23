import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/**
 * S1-1 kit form controls. Every field has a visible label; a hint and an error are linked to the control with
 * aria-describedby; an error also sets aria-invalid. Errors never blame the person: they say what is needed.
 */
interface FieldIds {
  readonly controlId: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}
const FieldContext = createContext<FieldIds | undefined>(undefined);

export function Field(props: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** Shown after the label; a required field says so in words, not with an asterisk alone. */
  optional?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const controlId = props.id ?? `f${auto}`;
  const hintId = props.hint !== undefined ? `${controlId}-hint` : undefined;
  const errorId = props.error !== undefined ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <FieldContext.Provider value={{ controlId, describedBy, invalid: props.error !== undefined }}>
      <div className="k-field" data-invalid={props.error !== undefined || undefined}>
        <label className="k-label" htmlFor={controlId}>
          {props.label}
          {props.optional === true ? <span className="k-optional"> (optional)</span> : null}
        </label>
        {props.hint !== undefined ? (
          <p id={hintId} className="k-hint">
            {props.hint}
          </p>
        ) : null}
        {props.children}
        {props.error !== undefined ? (
          <p id={errorId} className="k-error">
            <span className="k-error-mark" aria-hidden="true">
              !
            </span>
            {props.error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

function useField(): FieldIds {
  const f = useContext(FieldContext);
  if (f === undefined) throw new Error('A kit control must be inside <Field>, which gives it its label.');
  return f;
}

export function TextField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const f = useField();
  return <input {...props} id={f.controlId} className="k-input" aria-describedby={f.describedBy} aria-invalid={f.invalid || undefined} />;
}

export function TextArea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>) {
  const f = useField();
  return (
    <textarea
      rows={4}
      {...props}
      id={f.controlId}
      className="k-input k-textarea"
      aria-describedby={f.describedBy}
      aria-invalid={f.invalid || undefined}
    />
  );
}

/** A native select: the most accessible choice for a short list. Long or searchable lists use a combobox (S1-5). */
export function Select(
  props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { options: readonly { value: string; label: string }[] },
) {
  const f = useField();
  const { options, ...rest } = props;
  return (
    <span className="k-select">
      <select {...rest} id={f.controlId} className="k-input" aria-describedby={f.describedBy} aria-invalid={f.invalid || undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A single checkbox with its own label (not inside <Field>). */
export function Checkbox(props: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="k-check">
      <input
        id={id}
        type="checkbox"
        className="k-check-box"
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.hint !== undefined ? `${id}-hint` : undefined}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <label htmlFor={id} className="k-check-label">
        {props.label}
        {props.hint !== undefined ? (
          <span id={`${id}-hint`} className="k-hint">
            {props.hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** One choice of several, with native radios (arrow keys move between them). */
export function RadioGroup<T extends string>(props: {
  legend: string;
  value: T | undefined;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; hint?: string }[];
  error?: string;
}) {
  const name = useId();
  return (
    <fieldset className="k-fieldset" aria-describedby={props.error !== undefined ? `${name}-error` : undefined}>
      <legend className="k-label">{props.legend}</legend>
      {props.options.map((o) => (
        <div key={o.value} className="k-check">
          <input
            id={`${name}-${o.value}`}
            type="radio"
            name={name}
            className="k-check-box k-radio"
            checked={props.value === o.value}
            onChange={() => props.onChange(o.value)}
          />
          <label htmlFor={`${name}-${o.value}`} className="k-check-label">
            {o.label}
            {o.hint !== undefined ? <span className="k-hint">{o.hint}</span> : null}
          </label>
        </div>
      ))}
      {props.error !== undefined ? (
        <p id={`${name}-error`} className="k-error">
          {props.error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** An on/off setting that takes effect at once (use a checkbox inside a form that is saved with a button). */
export function Switch(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="k-switch-row">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        className="k-switch"
        aria-describedby={props.hint !== undefined ? `${id}-hint` : undefined}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="k-switch-thumb" aria-hidden="true" />
      </button>
      <label htmlFor={id} className="k-check-label">
        {props.label}
        {props.hint !== undefined ? (
          <span id={`${id}-hint`} className="k-hint">
            {props.hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/**
 * Drop files here, or choose them. The chooser is a real file input behind a visible button, so it works with keyboard, screen
 * readers and phones; dropping is an extra. `accept` is a hint to the chooser; the platform checks every file again.
 */
export function FileDrop(props: {
  label: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [over, setOver] = useState(false);
  return (
    <div
      className="k-drop"
      data-over={over || undefined}
      onDragOver={(e) => {
        if (props.disabled === true) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (props.disabled === true) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) props.onFiles(props.multiple === true ? files : files.slice(0, 1));
      }}
    >
      <p className="k-drop-title">{props.label}</p>
      {props.hint !== undefined ? (
        <p id={`${id}-hint`} className="k-hint">
          {props.hint}
        </p>
      ) : null}
      <input
        ref={input}
        id={id}
        type="file"
        className="k-visually-hidden"
        accept={props.accept}
        multiple={props.multiple}
        disabled={props.disabled}
        aria-describedby={props.hint !== undefined ? `${id}-hint` : undefined}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) props.onFiles(files);
          e.target.value = '';
        }}
      />
      <label htmlFor={id} className="k-btn k-btn-secondary k-btn-md" aria-disabled={props.disabled || undefined}>
        Choose {props.multiple === true ? 'files' : 'a file'}
      </label>
    </div>
  );
}

/**
 * The errors of a form after a submit, at the top, each a link to its field. It takes focus, so a screen-reader user hears how
 * many things need fixing; the fields keep their own messages too.
 */
export function FormErrors(props: { errors: readonly { fieldId: string; message: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = props.errors.length > 0;
  const last = useRef(0);
  if (shown && last.current !== props.errors.length) queueMicrotask(() => ref.current?.focus());
  last.current = props.errors.length;
  if (!shown) return null;
  return (
    <div ref={ref} className="k-form-errors" role="alert" tabIndex={-1} aria-labelledby="k-form-errors-h">
      <p id="k-form-errors-h" className="k-form-errors-title">
        {props.errors.length === 1 ? '1 thing needs your attention' : `${props.errors.length} things need your attention`}
      </p>
      <ul>
        {props.errors.map((e) => (
          <li key={e.fieldId}>
            <a href={`#${e.fieldId}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

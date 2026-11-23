import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>;

/**
 * S1-1 kit button. One primary per screen. `loading` keeps the button focusable and announced as busy while an action is in
 * flight; `disabledReason` makes it unavailable AND says why, next to it (a disabled button without a reason is not allowed in
 * the kit: a person must know what to do instead). Unavailable buttons stay focusable so keyboard and screen-reader users can
 * reach the reason.
 */
export type ButtonProps = NativeButton & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Why it cannot be used now. Shown below the button and linked to it. */
  disabledReason?: string | undefined;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const { variant = 'secondary', size = 'md', loading = false, disabledReason, icon, className, onClick, children, ...rest } = props;
  const reasonId = useId();
  const unavailable = loading || disabledReason !== undefined;
  const button = (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={['k-btn', `k-btn-${variant}`, `k-btn-${size}`, className].filter(Boolean).join(' ')}
      aria-disabled={unavailable || undefined}
      aria-busy={loading || undefined}
      aria-describedby={disabledReason !== undefined ? reasonId : rest['aria-describedby']}
      onClick={unavailable ? (e) => e.preventDefault() : onClick}
    >
      {loading ? <span className="k-spin" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
  if (disabledReason === undefined) return button;
  return (
    <span className="k-btn-wrap">
      {button}
      <span id={reasonId} className="k-btn-reason">
        {disabledReason}
      </span>
    </span>
  );
});

/** A button that is only an icon. The label is required and becomes its accessible name (and its tooltip). */
export function IconButton(props: NativeButton & { label: string; icon: ReactNode; size?: ButtonSize }) {
  const { label, icon, size = 'md', className, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      className={['k-icon-btn', `k-icon-btn-${size}`, className].filter(Boolean).join(' ')}
    >
      {icon}
    </button>
  );
}

/**
 * For an action that cannot be undone: the first press asks, the second confirms. A destructive action can also require the
 * person to type a word (for example the workspace's name). Escape or "Keep it" backs out; nothing happens until the confirm.
 */
export function ConfirmButton(props: {
  children: ReactNode;
  /** What will happen, in one sentence, shown while asking. */
  consequence: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: 'secondary' | 'danger';
  /** When set, the confirm stays unavailable until this exact text is typed. */
  typeToConfirm?: string;
  disabledReason?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const first = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typedOk = props.typeToConfirm === undefined || typed === props.typeToConfirm;

  useEffect(() => {
    if (asking && props.typeToConfirm === undefined) confirmRef.current?.focus();
  }, [asking, props.typeToConfirm]);

  if (!asking)
    return (
      <Button
        ref={first}
        variant={props.variant ?? 'secondary'}
        disabledReason={props.disabledReason}
        onClick={() => {
          setTyped('');
          setAsking(true);
        }}
      >
        {props.children}
      </Button>
    );
  const back = () => {
    setAsking(false);
    queueMicrotask(() => first.current?.focus());
  };
  return (
    <div
      className="k-confirm"
      role="group"
      aria-label={props.confirmLabel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          back();
        }
      }}
    >
      <p className="k-confirm-text">{props.consequence}</p>
      {props.typeToConfirm !== undefined ? (
        <div className="k-field">
          <label htmlFor={inputId} className="k-label">
            Type <strong>{props.typeToConfirm}</strong> to confirm
          </label>
          <input id={inputId} className="k-input" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      ) : null}
      <div className="k-row">
        <Button
          ref={confirmRef}
          variant={props.variant === 'danger' ? 'danger' : 'primary'}
          disabledReason={typedOk ? undefined : 'Type the text above first.'}
          onClick={() => {
            setAsking(false);
            props.onConfirm();
          }}
        >
          {props.confirmLabel}
        </Button>
        <Button variant="quiet" onClick={back}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
